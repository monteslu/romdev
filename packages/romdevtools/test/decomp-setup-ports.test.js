// JS ports of the Python scripts decomp projects run during setup
// (setup-ports.js, dispatched by recipe.js by the scripts' sha256):
// rom_decompressor.py, extract_compressed_segments.py, mio0_extract.py.
//
// The synthetic tests pin the behaviour on generated data. The checkout tests
// run the ports on a real project and compare against the outputs its Python
// scripts produced; they skip unless pointed at a checkout:
//   ROMDEV_TEST_SETUP_COMPRESSED=<checkout with tools/compressor/ and config/<ver>/baserom.<ver>.z64>
//   ROMDEV_TEST_SETUP_COMPRESSED_REF=<its bin/<ver>/compressed_segments/ from the Python script>
//   ROMDEV_TEST_SETUP_MIO0=<checkout with tools/mio0_extract.py and its base ROM>
process.env.ROM_DEV_WASM_POOL_SIZE ??= "2";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, "..", "build", "test-tmp", `decomp-setup-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });

const { romDecompress, parseBaseromHashes, extractCompressedSegments, mio0Extract, mio0DecompressScript, parseMio0Offsets } = await import("../src/decomp/setup-ports.js");
const { runRecipeLine, classifyCommand } = await import("../src/decomp/recipe.js");
const { shutdown } = await import("../src/toolchains/_worker/pool.js");

after(async () => { await shutdown(); fs.rmSync(TMP, { recursive: true, force: true }); });

const md5 = (b) => createHash("md5").update(b).digest("hex");
const sha1 = (b) => createHash("sha1").update(b).digest("hex");

function syntheticRom() {
  // [0,0x40) as-is | seg a (deflated) | gap as-is | seg b (deflated) | tail as-is
  const plainA = Buffer.from("A".repeat(100) + "hello world ".repeat(20));
  const plainB = Buffer.alloc(0x123, 7);
  const a = deflateRawSync(plainA, { level: 9 }), b = deflateRawSync(plainB, { level: 6 });
  // Trailing bytes after each deflate stream (the real ROMs pad segments) are ignored.
  const aSeg = Buffer.concat([a, Buffer.from([0xaa, 0xbb, 0xcc])]);
  const head = Buffer.alloc(0x40, 1), gap = Buffer.from("GAPGAPGAP"), tail = Buffer.from("TAIL!");
  const rom = Buffer.concat([head, aSeg, gap, b, tail]);
  const aStart = 0x40, aEnd = aStart + aSeg.length, bStart = aEnd + gap.length, bEnd = bStart + b.length;
  const hx = (v) => "0x" + v.toString(16).toUpperCase();
  const csv = "segment name,compressed rom offset start,compressed rom offset end,uncompressed hash,compression level,compression tool\n" +
    `seg_b,${hx(bStart)},${hx(bEnd)},${md5(plainB)},6,gzip_smallmem\n` +
    `seg_a,${hx(aStart)},${hx(aEnd)},${md5(plainA)},9,gzip_smallmem\n`;
  return { rom, csv, plainA, plainB, head, gap, tail, aStart, aEnd, bStart, bEnd };
}

const pad16 = (b) => Buffer.concat([b, Buffer.alloc((16 - (b.length % 16)) % 16)]);

test("rom_decompressor port: inflates csv segments, copies the gaps, pads each piece to 0x10", () => {
  const s = syntheticRom();
  const r = romDecompress({ inRom: s.rom, segmentsCsv: s.csv, version: "xx", baseromHashes: { xx: md5(s.rom) } });
  const want = Buffer.concat([s.head, s.plainA, s.gap, s.plainB, s.tail].map(pad16));
  assert.ok(r.rom.equals(want));
  assert.equal(r.log.split("\n").filter(Boolean).length, 5);
  assert.match(r.log, /^Range \[0x000000:0x000040\]: Writing as-is at offset 0x000000\nRange \[0x000040:0x[0-9A-F]{6}\]: Decompressing at offset 0x000040\n/);
  // The script's md5 gate on the input ROM.
  assert.throws(() => romDecompress({ inRom: s.rom, segmentsCsv: s.csv, version: "xx", baseromHashes: { xx: "0".repeat(32) } }), /Baserom's hash differs/);
  assert.deepEqual(parseBaseromHashes('BASEROM_HASHES = {\n    "us": "0123abcd",\n    "cn": "ff",\n}\n'), { us: "0123abcd", cn: "ff" });
});

test("extract_compressed_segments port: raw segment bytes to bin/<ver>/compressed_segments/", () => {
  const s = syntheticRom();
  const r = extractCompressedSegments({ inRom: s.rom, segmentsCsv: s.csv, version: "xx" });
  assert.deepEqual(r.files.map((f) => f.path), ["bin/xx/compressed_segments/seg_b_compressed.bin", "bin/xx/compressed_segments/seg_a_compressed.bin"]);
  assert.ok(r.files[1].bytes.equals(s.rom.subarray(s.aStart, s.aEnd)));
  assert.equal(r.log, "Extracting bin/xx/compressed_segments/seg_b_compressed.bin\nExtracting bin/xx/compressed_segments/seg_a_compressed.bin\n");
});

/** A MIO0 block: literal bytes and (length, distance) back-references. */
function mio0Encode(ops, size) {
  const bits = [], comp = [], raw = [];
  for (const op of ops) {
    if (typeof op === "number") { bits.push(1); raw.push(op); }
    else { bits.push(0); const v = ((op[0] - 3) << 12) | (op[1] - 1); comp.push(v >> 8, v & 0xff); }
  }
  const bitBytes = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) bitBytes[i >> 3] |= 0x80 >> (i & 7); });
  const compOff = 16 + bitBytes.length, rawOff = compOff + comp.length;
  const h = Buffer.alloc(16);
  h.write("MIO0", 0, "latin1"); h.writeUInt32BE(size, 4); h.writeUInt32BE(compOff, 8); h.writeUInt32BE(rawOff, 12);
  return Buffer.concat([h, bitBytes, Buffer.from(comp), Buffer.from(raw)]);
}

test("mio0_extract port: 64 KiB windows, decompression with the script's quirks, error lines", () => {
  const good = mio0Encode([0x41, 0x42, [6, 2], 0x43], 9); // AB + ABABAB + C
  assert.equal(mio0DecompressScript(good).toString("latin1"), "ABABABABC");
  const bad = mio0Encode([0x41, [3, 5]], 4); // distance past the start
  assert.throws(() => mio0DecompressScript(bad), /Invalid MIO0 backreference distance/);
  const rom = Buffer.alloc(0x100);
  good.copy(rom, 0x10); bad.copy(rom, 0x80);
  const r = mio0Extract({ rom, offsets: [0x10, 0x40, 0x80] }); // 0x40 holds no MIO0 header: skipped
  assert.deepEqual(r.files.map((f) => f.path), ["mio0/mio0_extracted/mio0_00000010.bin", "mio0/mio0_decompressed/decompressed_00000010.bin", "mio0/mio0_extracted/mio0_00000080.bin"]);
  assert.equal(r.files[0].bytes.length, 0x100 - 0x10, "the window stops at the end of the ROM");
  assert.match(r.log, /\[SUCCESS\] Decompressed file saved: mio0\/mio0_decompressed\/decompressed_00000010\.bin\n\[ERROR\] Failed to decompress MIO0 block at 00000080: Invalid MIO0 backreference distance\n/);
  assert.match(r.log, /Extracted and decompressed 2 MIO0 blocks\.\n$/);
  assert.deepEqual(parseMio0Offsets("x = 1\n    target_mio0_offsets = [\n        0x1AE660,\n        0x10,\n    ]\n"), [0x1ae660, 0x10]);
});

test("the setup scripts dispatch by sha256: a different script is not assumed to be the port", () => {
  const d = path.join(TMP, "sha");
  fs.mkdirSync(path.join(d, "tools"), { recursive: true });
  fs.writeFileSync(path.join(d, "tools", "mio0_extract.py"), "print('another program')\n");
  const c = classifyCommand(["uv", "run", "python3", "tools/mio0_extract.py", "rom.z64"], d);
  assert.equal(c.kind, "unsupported");
  assert.match(c.reason, /is not the version romdev ported/);
});

const COMP = process.env.ROMDEV_TEST_SETUP_COMPRESSED, COMP_REF = process.env.ROMDEV_TEST_SETUP_COMPRESSED_REF;
test("an N64 project's rom_decompressor.py and extract_compressed_segments.py steps, byte for byte", { skip: !COMP && "ROMDEV_TEST_SETUP_COMPRESSED not set" }, async () => {
  const version = process.env.ROMDEV_TEST_SETUP_VERSION ?? "us";
  const d = path.join(TMP, "compressed");
  fs.mkdirSync(path.join(d, "config", version), { recursive: true });
  fs.cpSync(path.join(COMP, "tools", "compressor"), path.join(d, "tools", "compressor"), { recursive: true });
  fs.symlinkSync(path.join(COMP, "config", version, `baserom.${version}.z64`), path.join(d, "config", version, `baserom.${version}.z64`));
  const tmpRoot = path.join(TMP, "compressed-tmp");
  const csv = `tools/compressor/compress_segments.${version}.csv`;
  let r = await runRecipeLine(`uv run python tools/compressor/rom_decompressor.py config/${version}/baserom.${version}.z64 config/${version}/out.z64 ${csv} ${version}`, { cwd: d, tmpRoot });
  assert.equal(r.code, 0, r.log + (r.unsupported ?? ""));
  assert.equal(r.steps[0].kind, "rom-decompressor");
  // The splat yaml's sha1 is the uncompressed ROM's.
  const yaml = fs.readdirSync(path.join(COMP, "config", version)).find((f) => f.endsWith(".yaml"));
  const want = /^sha1:\s*([0-9a-f]{40})/m.exec(fs.readFileSync(path.join(COMP, "config", version, yaml), "utf8"))[1];
  const out = fs.readFileSync(path.join(d, "config", version, "out.z64"));
  assert.ok(out.length > 0x100000);
  assert.equal(sha1(out), want);
  r = await runRecipeLine(`uv run python tools/compressor/extract_compressed_segments.py config/${version}/baserom.${version}.z64 ${csv} ${version}`, { cwd: d, tmpRoot });
  assert.equal(r.code, 0, r.log + (r.unsupported ?? ""));
  const got = path.join(d, "bin", version, "compressed_segments");
  const rows = fs.readFileSync(path.join(d, csv), "utf8").split("\n").slice(1).filter(Boolean).length;
  assert.equal(fs.readdirSync(got).length, rows);
  if (COMP_REF) {
    const ref = fs.readdirSync(COMP_REF).sort();
    assert.deepEqual(fs.readdirSync(got).sort(), ref);
    for (const f of ref) assert.ok(fs.readFileSync(path.join(got, f)).equals(fs.readFileSync(path.join(COMP_REF, f))), f);
  }
});

const MIO = process.env.ROMDEV_TEST_SETUP_MIO0;
test("an N64 project's mio0_extract.py step: every block decodes like crunch64's mio0 on the whole block", { skip: !MIO && "ROMDEV_TEST_SETUP_MIO0 not set" }, async () => {
  const { decompTool } = await import("../src/decomp/toolchain.js");
  const d = path.join(TMP, "mio0");
  fs.mkdirSync(path.join(d, "tools"), { recursive: true });
  fs.copyFileSync(path.join(MIO, "tools", "mio0_extract.py"), path.join(d, "tools", "mio0_extract.py"));
  const romName = fs.readdirSync(MIO).find((f) => /^baserom\..*\.z64$/.test(f));
  fs.symlinkSync(path.join(MIO, romName), path.join(d, romName));
  const r = await runRecipeLine(`python3 tools/mio0_extract.py ${romName}`, { cwd: d, tmpRoot: path.join(TMP, "mio0-tmp") });
  assert.equal(r.code, 0, r.log + (r.unsupported ?? ""));
  const offsets = parseMio0Offsets(fs.readFileSync(path.join(d, "tools", "mio0_extract.py"), "utf8"));
  assert.ok(offsets.length > 10);
  assert.equal(fs.readdirSync(path.join(d, "mio0", "mio0_decompressed")).length, offsets.length);
  const rom = fs.readFileSync(path.join(d, romName));
  const work = path.join(TMP, "mio0-c64");
  fs.mkdirSync(work, { recursive: true });
  let windowed = 0;
  for (const off of offsets) {
    const block = rom.subarray(off, Math.min(rom.length, off + 0x200000));
    fs.writeFileSync(path.join(work, "in.bin"), block);
    const x = await decompTool("crunch64", ["decompress", "mio0", "in.bin", "out.bin"], { cwd: work });
    assert.equal(x.exitCode, 0, x.log);
    const ref = fs.readFileSync(path.join(work, "out.bin"));
    // The port's decoder, given the whole block, is crunch64's mio0.
    assert.ok(mio0DecompressScript(block).equals(ref), off.toString(16));
    // The script decodes only its 64 KiB window: a block whose streams run
    // past it comes out short, exactly as the script writes it.
    const h = off.toString(16).toUpperCase().padStart(8, "0");
    const got = fs.readFileSync(path.join(d, "mio0", "mio0_decompressed", `decompressed_${h}.bin`));
    if (!got.equals(ref)) { windowed++; assert.ok(got.equals(mio0DecompressScript(block.subarray(0, 0x10000)))); }
  }
  assert.ok(windowed < offsets.length / 10, `${windowed} windowed blocks`);
});
