// Maintainer-only mechanical data regeneration, not an agent/API tool.
//
//   node scripts/recompile-gen/gba-mgba.mjs [--mgba <dir>] [--musl <exp2f_data.c>] [--write]
//
// Produces src/analysis/recompile/wat/gba/mgba-data.json: everything the GBA
// WAT backend takes from mGBA (and musl), so a recompile never needs emulator
// source on disk:
//
//   armTable / thumbTable   mGBA's decoder: handler name per ARM index
//                           ((op >> 16) & 0xFF0 | (op >> 4) & 0xF) and per
//                           Thumb op >> 6, expanded from emitter-arm.h /
//                           emitter-thumb.h by the C preprocessor
//   hleBios                 src/gba/hle-bios.c, zero-filled to 16KB (base64)
//   waitstates              memory.c GBA_BASE_WAITSTATES* / GBA_ROM_WAITSTATES*
//   dmaOffset               dma.c DMA_OFFSET
//   timerPrescale           timer.c prescaleTable
//   sioCycles               sio.c GBASIOCyclesPerTransfer[*][0] (one GBA attached)
//   conditionLut            arm.c conditionLut
//   vstallLut               memory.c GBAMemoryStallVRAM stallLUT
//   deadbeef                memory.c _deadbeef (open-bus fetch of a bad region)
//   romHackRule             GBAOverrideApplyDefaults' unknown-dump rule (header
//                           bytes, known CRC32s, FLASH1M + RTC + vbaBugCompat)
//   overrides               overrides.c _overrides: id -> savetype, hardware
//                           (interface.h HW_* bits, when not HW_NONE), idle loop
//   exp2fTab                musl __exp2f_data.tab (mGBA's MidiKey2Freq calls exp2f)
//   sintab                  f32 sinf/cosf of theta = f32(f32(k / 128) * pi), the
//                           HLE BIOS BgAffineSet/ObjAffineSet trig (correctly
//                           rounded, which is what glibc sinf/cosf return)
//
// --mgba defaults to romdev's pinned checkout (build/mgba/src, versions.json
// cores.mgba). Sources are read from the pinned commit's git objects when the
// tree is a git checkout, so romdev's local core patch never leaks in.
// Default mode verifies the committed JSON; --write replaces it.
//
// License: mGBA is MPL-2.0. The tables are data extracted from MPL-2.0 files;
// provenance (commit, file SHA256s) is recorded in the output so the covered
// source files can be identified, per MPL-2.0 section 3.2. musl is MIT.
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { revParseHead, showFile } from "../../src/git/index.js";
import assert from "node:assert/strict";

const here = path.dirname(new URL(import.meta.url).pathname);
const PKG = path.resolve(here, "../..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MGBA = path.resolve(opt("--mgba", path.join(process.env.ROMDEV_BUILD_DIR ?? path.join(PKG, "build"), "mgba/src")));
const MUSL = opt("--musl", path.join(process.env.EMSDK ?? path.resolve(PKG, "../../../emsdk"),
  "upstream/emscripten/system/lib/libc/musl/src/math/exp2f_data.c"));
const OUT = path.join(PKG, "src/analysis/recompile/wat/gba/mgba-data.json");
const versions = JSON.parse(await readFile(path.join(PKG, "scripts/versions.json"), "utf8"));
const pin = versions.cores?.mgba ?? Object.values(versions).find((v) => v?.mgba)?.mgba;

const isGit = existsSync(path.join(MGBA, ".git"));
let commit = null;
if (isGit) commit = revParseHead(MGBA);
if (pin?.commit) assert.equal(commit, pin.commit, `mGBA checkout ${commit} is not the pinned ${pin.commit}`);

const files = {};
/** `git show HEAD:<rel>` of the mGBA checkout, read without a git process. */
function committedText(rel) {
  const buf = showFile(MGBA, rel, "HEAD");
  if (buf === null) throw new Error(`${rel} is not in the mGBA checkout's HEAD`);
  return buf.toString("utf8");
}
/** Read an mGBA source file as committed (git object), recording its hash. */
function src(rel) {
  const text = isGit
    ? committedText(rel)
    : execFileSync("cat", [path.join(MGBA, rel)], { encoding: "utf8", maxBuffer: 1 << 26 });
  files[rel] = createHash("sha256").update(text).digest("hex");
  return text;
}
const clean = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
/** Numbers of a C initializer `name[...] = { ... }`. */
function cArray(text, name, n) {
  const m = new RegExp(`${name}\\s*(?:\\[[^\\]]*\\])+\\s*=\\s*\\{([^;]*?)\\};`).exec(clean(text));
  assert.ok(m, `missing ${name}`);
  const v = m[1].replace(/[{}]/g, " ").split(",").map((s) => s.trim()).filter(Boolean).map((s) => Number(s));
  v.forEach((x) => assert.ok(Number.isFinite(x), `${name}: non-numeric term`));
  if (n != null) { assert.ok(v.length <= n, `${name} longer than ${n}`); while (v.length < n) v.push(0); }
  return v;
}

// --- decoder tables: cpp over the emitter headers (header-only, unpatched)
const inc = path.join(MGBA, "include/mgba/internal/arm");
for (const h of ["emitter-arm.h", "emitter-thumb.h", "emitter-inlines.h"]) src(`include/mgba/internal/arm/${h}`);
const cppOut = execFileSync("cc", ["-E", "-P", "-I", inc, "-I", path.join(MGBA, "include"), "-"], {
  input: '#include "emitter-arm.h"\nARMTABLE DECLARE_ARM_EMITTER_BLOCK(_A)\n#include "emitter-thumb.h"\nTHUMBTABLE DECLARE_THUMB_EMITTER_BLOCK(_T)\n',
  encoding: "utf8", maxBuffer: 1 << 26,
});
function table(tag, prefix, n) {
  const i = cppOut.indexOf(tag + " ");
  assert.ok(i >= 0, `cpp output lacks ${tag}`);
  const line = cppOut.slice(i + tag.length + 1).split("\n")[0];
  const names = line.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    assert.ok(s.startsWith(prefix), `${tag}: ${s}`);
    return s.slice(prefix.length);
  });
  assert.equal(names.length, n, `${tag} length`);
  return names;
}
const armTable = table("ARMTABLE", "_A", 4096);
const thumbTable = table("THUMBTABLE", "_T", 1024);

// --- HLE BIOS
const hle = src("src/gba/hle-bios.c");
const body = hle.slice(hle.indexOf("{") + 1, hle.lastIndexOf("}"));
const biosBytes = [...body.matchAll(/0x([0-9a-fA-F]{2})/g)].map((m) => parseInt(m[1], 16));
assert.ok(biosBytes.length > 0 && biosBytes.length <= 0x4000, "hle-bios size");
const bios = Buffer.alloc(0x4000);
Buffer.from(biosBytes).copy(bios);

// --- memory.c
const mem = src("src/gba/memory.c");
const waitstates = {
  nonseq16: cArray(mem, "GBA_BASE_WAITSTATES", 16),
  seq16: cArray(mem, "GBA_BASE_WAITSTATES_SEQ", 16),
  nonseq32: cArray(mem, "GBA_BASE_WAITSTATES_32", 16),
  seq32: cArray(mem, "GBA_BASE_WAITSTATES_SEQ_32", 16),
  rom: cArray(mem, "GBA_ROM_WAITSTATES"),
  romSeq: cArray(mem, "GBA_ROM_WAITSTATES_SEQ"),
};
const deadbeef = cArray(mem, "_deadbeef");
const vh = clean(src("include/mgba/internal/gba/video.h"));
const vmac = {};
for (const m of vh.matchAll(/#define (GBA_VSTALL_\w+)(\(X\))?\s+(.+)/g)) vmac[m[1]] = { arg: !!m[2], body: m[3].trim() };
const vl = /stallLUT\[32\]\s*=\s*\{([\s\S]*?)\};/.exec(clean(mem));
assert.ok(vl, "stallLUT");
const vstallLut = vl[1].split(",").map((s) => s.trim()).filter(Boolean).map((term) => term.split("|").map((t) => {
  t = t.trim();
  const m = /^(GBA_VSTALL_\w+)(?:\((\d+)\))?$/.exec(t);
  assert.ok(m && vmac[m[1]], `stallLUT term ${t}`);
  const e = vmac[m[1]].body.replace(/\bX\b/g, m[2] ?? "0");
  assert.ok(/^[0-9a-fA-Fx()<\s]+$/.test(e), `macro ${m[1]}`);
  return Function(`return ${e}`)();
}).reduce((a, b) => a | b, 0));
assert.equal(vstallLut.length, 32);

const dmaOffset = cArray(src("src/gba/dma.c"), "DMA_OFFSET");
const timerPrescale = cArray(src("src/gba/timer.c"), "prescaleTable");
const sioRows = cArray(src("src/gba/sio.c"), "GBASIOCyclesPerTransfer");
assert.equal(sioRows.length % 4, 0);
const sioCycles = [0, 1, 2, 3].map((i) => sioRows[i * (sioRows.length / 4)]);
const armc = src("src/arm/arm.c");
const conditionLut = cArray(armc, "conditionLut", 16);

// --- overrides
const ov = clean(src("src/gba/overrides.c"));
const iface = clean(src("include/mgba/gba/interface.h"));
const saveEnum = {};
for (const m of iface.matchAll(/(GBA_SAVEDATA_\w+)\s*=\s*(-?\d+)/g)) saveEnum[m[1]] = Number(m[2]);
const ovBody = /_overrides\[\]\s*=\s*\{([\s\S]*?)\n\};/.exec(ov);
assert.ok(ovBody, "_overrides");
const hwEnum = {};
for (const m of iface.matchAll(/\b(HW_\w+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*,/g)) hwEnum[m[1]] = Number(m[2]);
assert.ok(hwEnum.HW_RTC === 1 && hwEnum.HW_NO_OVERRIDE === 0x8000, "HW_ enum moved; review the override hardware bits");
const hwBits = (e) => e === "HW_NONE" ? 0 : e.split("|").map((t) => t.trim()).reduce((a, t) => { assert.ok(t in hwEnum, `hardware ${t}`); return a | hwEnum[t]; }, 0);
const overrides = {};
for (const m of ovBody[1].matchAll(/\{\s*"(\w{4})"\s*,\s*(GBA_SAVEDATA_\w+)\s*,\s*([^,]+?)\s*,\s*([^,}]+?)\s*(?:,\s*([^}]+?)\s*)?\}/g)) {
  assert.ok(m[2] in saveEnum, `savetype ${m[2]}`);
  const idle = m[4] === "GBA_IDLE_LOOP_NONE" ? null : Number(m[4]);
  assert.ok(idle === null || Number.isFinite(idle), `idle ${m[4]}`);
  const hardware = hwBits(m[3]);
  overrides[m[1]] = hardware && hardware !== hwEnum.HW_NO_OVERRIDE ? { savetype: saveEnum[m[2]], hardware, idleLoop: idle } : { savetype: saveEnum[m[2]], idleLoop: idle };
}
assert.ok(Object.keys(overrides).length > 50 && overrides.AWRE, "override table");
// GBAOverrideApplyDefaults' ROM-hack rule: header strings compared with
// strncmp (at their offsets, n bytes), the known dumps' CRC32s, and what an
// unknown image gets. Kept as bytes, not names.
const ruleBody = /GBAOverrideApplyDefaults[\s\S]*?\n\}/.exec(ov)[0];
const crcBody = /static const uint32_t \w+\[\] = \{([\s\S]*?)\};/.exec(ruleBody);
assert.ok(crcBody, "ROM-hack rule: CRC table");
const hackCrcs = [...crcBody[1].matchAll(/0x([0-9A-Fa-f]{8})/g)].map((m) => parseInt(m[1], 16));
const hackMatches = [...ruleBody.matchAll(/!strncmp\("([^"]+)", &\(\(const char\*\) gba->memory\.rom\)\[(0x[0-9A-Fa-f]+)\], (\d+)\)/g)]
  .map((m) => ({ offset: Number(m[2]), n: Number(m[3]), hex: Buffer.from(m[1] + "\0", "latin1").subarray(0, Number(m[3])).toString("hex") }));
assert.ok(hackCrcs.length >= 10 && hackMatches.length >= 2, "ROM-hack rule moved; review GBAOverrideApplyDefaults");
assert.ok(/override\.savetype = GBA_SAVEDATA_FLASH1M;\s*override\.hardware = HW_RTC;\s*override\.vbaBugCompat = true;/.test(ruleBody), "ROM-hack rule's override changed");
const romHackRule = { matches: hackMatches, knownCrc32: hackCrcs, savetype: saveEnum.GBA_SAVEDATA_FLASH1M, hardware: 1, vbaBugCompat: true };
assert.ok(/override->id\[0\] == 'F'/.test(ov), "'F' game-code EEPROM rule moved; review GBAOverrideFind");

// --- musl exp2f
const musl = await readFile(MUSL, "utf8");
const exp2 = /\.tab\s*=\s*\{([\s\S]*?)\}/.exec(clean(musl));
assert.ok(exp2, "musl exp2f tab");
const exp2fTab = exp2[1].split(",").map((s) => s.trim()).filter(Boolean);
assert.equal(exp2fTab.length, 32);
exp2fTab.forEach((s) => assert.ok(/^0x[0-9a-f]{16}$/.test(s), s));

// --- sintab: f32 sin[256] then f32 cos[256]
const st = Buffer.alloc(2048);
let o = 0;
for (const fn of [Math.sin, Math.cos]) {
  for (let k = 0; k < 256; k++) {
    const th = Math.fround(Math.fround(k / 128) * Math.PI);
    st.writeFloatLE(Math.fround(fn(th)), o);
    o += 4;
  }
}

const generated = {
  provenance: {
    source: "mGBA (libretro/mgba) at romdev's pinned core commit; musl __exp2f_data",
    mgbaVersion: "0.11",
    mgbaCommit: commit,
    mgbaLicense: "MPL-2.0 (data extracted from the files listed; source: https://github.com/libretro/mgba)",
    mgbaFilesSha256: files,
    musl: { file: "src/math/exp2f_data.c", sha256: createHash("sha256").update(musl).digest("hex"), license: "MIT" },
    generator: "scripts/recompile-gen/gba-mgba.mjs",
  },
  armTable, thumbTable,
  hleBios: bios.toString("base64"),
  waitstates, dmaOffset, timerPrescale, sioCycles, conditionLut, vstallLut, deadbeef,
  overrides,
  romHackRule,
  exp2fTab,
  sintab: st.toString("base64"),
};
const text = JSON.stringify(generated) + "\n";
if (args.includes("--write")) await writeFile(OUT, text);
else assert.deepEqual(JSON.parse(await readFile(OUT, "utf8")), generated, "sources changed: review then regenerate with --write");
console.log(`${args.includes("--write") ? "Generated" : "Verified"} ${path.relative(PKG, OUT)}: ${armTable.length} ARM + ${thumbTable.length} Thumb decoder entries, ${Object.keys(overrides).length} overrides, mGBA ${commit}`);
