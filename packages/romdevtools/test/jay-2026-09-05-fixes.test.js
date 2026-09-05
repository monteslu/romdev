// The 2026-09-05 sync32 port feedback (jaymcgavren, romdevtools 0.135.1):
// every item that could be pinned with a unit test, pinned. Each test names
// the report item it closes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

import { compileExcludes, readIncludeDirs, readProjectDir, dropGenesisRomHeader, denoiseSuccessLog } from "../src/mcp/tools/toolchain.js";
import { naReason, CAPABILITIES } from "../src/cores/capabilities.js";
import { getInputLayoutCore } from "../src/mcp/tools/input-layout.js";
import { listPlatformDocsCore, getPlatformDocCore } from "../src/mcp/tools/platform-docs.js";
import { encodeIndexed, dedupeTiles, emitSheetC, emitTilemapC, rgb565 } from "../src/platforms/sync32/art.js";
import { compileSong } from "../src/platforms/sync32/song.js";
import { wavToSync32Pcm, emitSync32PcmC } from "../src/platforms/sync32/pcm.js";
import { feedbackEntry, recordFeedbackCore, listFeedbackCore } from "../src/mcp/tools/feedback.js";

// ── 004537 #3: output:'project' compiles every .c — `exclude` ──────────────

test("compileExcludes: bare names match at any depth, globs work, slashes anchor", () => {
  const f = compileExcludes(["asset_check.c", "*.test.c", "tests/**", "sub/only.c"]);
  assert.equal(f("asset_check.c"), true);
  assert.equal(f("deep/asset_check.c"), true);
  assert.equal(f("x.test.c"), true);
  assert.equal(f("src/x.test.c"), true);
  assert.equal(f("tests/a/b.c"), true);
  assert.equal(f("sub/only.c"), true);
  assert.equal(f("other/only.c"), false);
  assert.equal(f("main.c"), false);
  assert.equal(compileExcludes(undefined)("main.c"), false);
});

test("readProjectDir honours exclude: a second game_main beside the game stays out of the link", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-exclude-"));
  await writeFile(path.join(dir, "main.c"), "void game_main(void){}\n");
  await writeFile(path.join(dir, "asset_check.c"), "void game_main(void){}\n");
  await writeFile(path.join(dir, "res.h"), "#define X 1\n");
  const all = await readProjectDir(dir, "sync32");
  assert.deepEqual(Object.keys(all.sources).sort(), ["asset_check.c", "main.c"]);
  const some = await readProjectDir(dir, "sync32", { exclude: ["asset_check.c"] });
  assert.deepEqual(Object.keys(some.sources), ["main.c"]);
  assert.ok("res.h" in some.includes);
  await rm(dir, { recursive: true, force: true });
});

// ── 013208 #3: includePaths is a MAP; the directory form ───────────────────

test("readIncludeDirs stages every header under a tree keyed by relative path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-incdirs-"));
  await mkdir(path.join(dir, "shared", "sub"), { recursive: true });
  await writeFile(path.join(dir, "shared", "game_levels.h"), "// levels\n");
  await writeFile(path.join(dir, "shared", "sub", "tuning.h"), "// tuning\n");
  await writeFile(path.join(dir, "shared", "notes.txt"), "not a header\n");
  const inc = await readIncludeDirs([path.join(dir, "shared")]);
  assert.deepEqual(Object.keys(inc).sort(), ["game_levels.h", "sub/tuning.h"]);
  await assert.rejects(readIncludeDirs([path.join(dir, "missing")]), /includeDirs: cannot read/);
  await rm(dir, { recursive: true, force: true });
});

// ── 013208 #2: rom_header.c must not be a translation unit ─────────────────

test("dropGenesisRomHeader removes the project's rom_header.c on Genesis only", () => {
  const src = { "main.c": "", "rom_header.c": "", "res.c": "" };
  const g = dropGenesisRomHeader("genesis", src);
  assert.deepEqual(Object.keys(g.sources).sort(), ["main.c", "res.c"]);
  assert.deepEqual(g.dropped, ["rom_header.c"]);
  const n = dropGenesisRomHeader("nes", src);
  assert.equal(n.sources, src);
  assert.deepEqual(n.dropped, []);
  assert.equal(dropGenesisRomHeader("genesis", undefined).sources, undefined);
});

// ── 013208 #5: syscall + RWX warnings are noise on a successful build ───────

test("denoiseSuccessLog strips the WASM syscall chatter and the RWX segment warning", () => {
  const log = [
    "cc1 (main.c)",
    "warning: unsupported syscall: __syscall_prlimit64",
    "warning: unsupported syscall: __syscall_prlimit64",
    "ld: warning: /work/main.elf has a LOAD segment with RWX permissions",
    "packed main.s32 (195880 bytes)",
  ].join("\n");
  const out = denoiseSuccessLog(log);
  assert.doesNotMatch(out, /prlimit64/);
  assert.doesNotMatch(out, /RWX/);
  assert.match(out, /packed main\.s32/);
});

// ── 004537 #9: naReasons named a region sync32 does not have; #5 budget ─────

test("sync32 naReasons point at sync32_canvas and do not call the console disc-based", () => {
  assert.match(naReason("sync32", "inspectSprites"), /sync32_canvas/);
  assert.doesNotMatch(naReason("sync32", "inspectSprites"), /video_ram/);
  assert.match(naReason("sync32", "cart"), /64-byte header/);
  assert.doesNotMatch(naReason("sync32", "cart"), /disc-based/);
});

test("sync32 capabilities carry the image budget the linker script defines", () => {
  const b = CAPABILITIES.sync32.imageBudget;
  assert.equal(b.ram.imageBytes, 311296);
  assert.equal(b.ram.base, 0x20030000);
  assert.equal(b.xip.base, 0x10100000);
  assert.equal(b.xip.ramBytes, 311296);
});

// ── 013208 #7: input({op:'layout', platform:'sync32'}) ─────────────────────

test("sync32 input layout: the S32_PAD_* bits and the by-name libretro mapping", () => {
  const l = getInputLayoutCore({ platform: "sync32" });
  assert.equal(l.hardwareBits.a, 0x1000);
  assert.equal(l.hardwareBits.b, 0x2000);
  assert.equal(l.hardwareBits.up, 0x0001);
  assert.ok(l.physicalButtons.includes("north"));
  assert.match(l.note, /Z = libretro b/);
});

// ── 004537 #4: sync32.h reachable through platform docs ────────────────────

test("platform docs list and serve the sync32 ABI header", async () => {
  const docs = await listPlatformDocsCore({ platform: "sync32" });
  assert.ok(docs.docs.some((d) => d.name === "abi"), "abi listed");
  const r = await getPlatformDocCore({ platform: "sync32", name: "abi" });
  const body = JSON.parse(r.content[0].text);
  assert.match(body.contents, /sync32_api_t/);
  assert.match(body.contents, /S32_PAD_A/);
  const alias = JSON.parse((await getPlatformDocCore({ platform: "sync32", name: "header" })).content[0].text);
  assert.equal(alias.contents, body.contents);
});

// ── 004537 #7: encodeArt for sync32 — banked quantization + chr/map dedup ──

function testPng(w, h, fn) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = fn(x, y);
    const o = (y * w + x) * 4;
    png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = a;
  }
  return PNG.sync.write(png);
}

test("encodeIndexed: index 0 is reserved for transparency, colours start at baseIndex, bank size honoured", () => {
  const bytes = testPng(16, 16, (x, y) => (x < 2 ? [0, 0, 0, 0] : [x * 15, y * 15, 128, 255]));
  const r = encodeIndexed(bytes, { maxColors: 32, baseIndex: 80 });
  assert.equal(r.width, 16);
  assert.equal(r.transparentPixels, 32);
  assert.equal(r.pixels[0], 0);
  const used = new Set(r.pixels.filter((p) => p !== 0));
  assert.ok(Math.min(...used) >= 80 && Math.max(...used) < 80 + 32, "indices inside the bank");
  assert.ok(r.colors <= 32 && r.colors > 8, `quantized to ${r.colors}`);
  assert.equal(r.paletteBytes.length, r.colors * 2);
  assert.equal(r.paletteBytes[0] | (r.paletteBytes[1] << 8), r.palette[0], "palette.bin is little-endian RGB565");
  assert.throws(() => encodeIndexed(bytes, { baseIndex: 0 }), /transparent key/);
  assert.match(emitSheetC("hero", r), /#define HERO_PAL_BASE 80/);
});

test("encodeIndexed: an image with few colours keeps them exact (no lossy median cut)", () => {
  const bytes = testPng(8, 8, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const r = encodeIndexed(bytes, { maxColors: 16 });
  assert.equal(r.colors, 2);
  assert.ok(r.palette.includes(rgb565(255, 0, 0)) && r.palette.includes(rgb565(0, 0, 255)));
  assert.equal(r.baseIndex, 1);
});

test("dedupeTiles: repeated cells collapse; flip matching folds mirrors and widens the map", () => {
  const bytes = testPng(32, 8, (x, y) => ((x >> 3) % 2 === 0 ? [200, 30, 30, 255] : [x % 8 < 4 ? 30 : 60, 200, 30, 255]));
  const r = encodeIndexed(bytes, { maxColors: 8 });
  const t = dedupeTiles(r.pixels, 32, 8);
  assert.equal(t.totalTiles, 4);
  assert.equal(t.uniqueTiles, 2);
  assert.equal(t.entryBits, 8);
  assert.deepEqual(Array.from(t.map), [0, 1, 0, 1]);
  // a horizontally mirrored cell
  const bytes2 = testPng(16, 8, (x) => (x < 8 ? (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]) : (x - 8 < 4 ? [0, 0, 255, 255] : [255, 0, 0, 255])));
  const r2 = encodeIndexed(bytes2, { maxColors: 4 });
  assert.equal(dedupeTiles(r2.pixels, 16, 8).uniqueTiles, 2);
  const f = dedupeTiles(r2.pixels, 16, 8, { flip: true });
  assert.equal(f.uniqueTiles, 1);
  assert.equal(f.entryBits, 16);
  assert.equal(f.map[1] >> 14, 1, "flip-X bit");
  assert.match(emitTilemapC("bg", r2, f), /BG_MAP_FLIP_X 0x4000/);
  assert.throws(() => dedupeTiles(r.pixels, 30, 8), /multiple of 8/);
});

// ── 004537 #8: encodeAudio for sync32 — note-song + PCM ────────────────────

test("compileSong: (hz, frames) events, rests, multi-voice, PSG quantization matches the Genesis grid", () => {
  const r = compileSong({ name: "danube", psgQuantize: true, voices: [{ rows: ["D4:21", "R:1", "F#4:21", "A4:21", "D5:21"] }, { rows: [{ note: "D3", ticks: 85 }] }] });
  assert.deepEqual(r.voices[0].events.map((e) => e[0]), [294, 0, 370, 440, 589]); // the report's own numbers
  assert.equal(r.voices.length, 2);
  assert.equal(r.frames, 85);
  assert.equal(r.bytes.length, (1 + 5 * 2 + 1 + 1 * 2) * 2);
  assert.match(r.cSource, /const s32_song_t danube/);
  assert.match(r.cSource, /294,21,\s+0,1,/);
  const plain = compileSong({ rows: ["A4:8"] });
  assert.equal(plain.voices[0].events[0][0], 440);
  assert.throws(() => compileSong({ rows: ["H4:8"] }), /bad note name/);
  assert.throws(() => compileSong({ rows: ["C4:0"] }), /bad duration/);
});

test("wavToSync32Pcm: s16 mono at a ring-dividing rate, with the hold step", () => {
  const rate = 48000, n = 480;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin(i / 10) * 20000);
  const r = wavToSync32Pcm(Buffer.from(pcm.buffer), { format: "pcm16", pcmRate: rate });
  assert.equal(r.rate, 24000);
  assert.equal(r.step, 2);
  assert.ok(Math.abs(r.sampleCount - 240) <= 1);
  assert.ok(r.peak > 15000);
  assert.throws(() => wavToSync32Pcm(Buffer.from(pcm.buffer), { format: "pcm16", pcmRate: rate, rate: 22050 }), /divide the 48000/);
  const c = emitSync32PcmC(r, "sfx_jump");
  assert.match(c, /#define SFX_JUMP_STEP 2/);
  assert.match(c, /const int16_t sfx_jump\[/);
});

// ── 015806 #5: a way to report a defect that stamps itself ──────────────────

test("feedback: entries are stamped and the log is local + append-only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-feedback-"));
  const prev = process.env.ROMDEV_FEEDBACK_PATH;
  process.env.ROMDEV_FEEDBACK_PATH = path.join(dir, "fb.jsonl");
  try {
    const e = feedbackEntry({ title: "x", body: "y", severity: "token" });
    assert.match(e.romdevVersion, /^\d+\.\d+\.\d+/);
    assert.equal(e.serverPid, process.pid);
    await recordFeedbackCore({ title: "one", body: "first" });
    await recordFeedbackCore({ title: "two", body: "second", tool: "build({output:'run'})" });
    const l = await listFeedbackCore({ last: 10 });
    assert.equal(l.total, 2);
    assert.equal(l.entries[1].tool, "build({output:'run'})");
    const raw = await readFile(process.env.ROMDEV_FEEDBACK_PATH, "utf8");
    assert.equal(raw.trim().split("\n").length, 2);
  } finally {
    if (prev === undefined) delete process.env.ROMDEV_FEEDBACK_PATH; else process.env.ROMDEV_FEEDBACK_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
