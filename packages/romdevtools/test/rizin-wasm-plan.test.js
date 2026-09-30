// The meson-free rizin build (scripts/rizin-wasm/build.mjs) is only as good as
// its frozen plan. These checks keep plan.json self-consistent and the JS port
// of libzip's zip_err_str generator faithful, without running emcc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipErrStr, parseWrap } from "../scripts/rizin-wasm/build.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "rizin-wasm");
const plan = JSON.parse(readFileSync(path.join(DIR, "plan.json"), "utf8"));

test("plan.json: every step is wired to something that exists", () => {
  const objs = new Set(plan.compile.map((c) => c.out));
  for (const c of plan.compile) assert.ok(plan.flagSets[c.flags], `bad flag set for ${c.src}`);
  for (const a of plan.archives) for (const m of a.members) assert.ok(objs.has(m), `${a.out} member ${m} is never compiled`);
  const archives = new Set(plan.archives.map((a) => a.out));
  const linked = plan.link.filter((a) => a.endsWith(".a") && !a.startsWith("@SYSROOT_LIB@"));
  assert.ok(linked.length > 20, "link line lost its archives");
  for (const a of linked) assert.ok(archives.has(a), `link uses ${a}, which no archive step builds`);
  for (const f of plan.configured) assert.ok(existsSync(path.join(DIR, "configured", f)), `configured/${f} missing`);
  assert.ok(!JSON.stringify(plan).includes("/home/"), "plan carries a machine-specific path");
  assert.ok(!JSON.stringify(plan).match(/python|meson\.py/), "plan invokes Python");
});

test("zipErrStr matches create_zip_err_str.py's output shape", () => {
  const zipH = [
    "#define ZIP_ER_OK 0               /* N No error */",
    "#define ZIP_ER_MULTIDISK 1        /* N Multi-disk zip archives not supported */",
    "#define ZIP_OPSYS_DOS 0x00u",
  ].join("\n");
  const zipintH = "#define ZIP_ER_DETAIL_NO_DETAIL 0 /* G no detail */\n#define ZIP_ER_DETAIL_X 1 /* E entry x */";
  const out = zipErrStr(zipH, zipintH);
  assert.match(out, /_zip_err_str\[\] = \{\n\{N, "No"\},\n\{N, "Multi-disk"\},\n\};/);
  assert.match(out, /_zip_err_details\[\] = \{\n\{G, "no"\},\n\{E, "entry"\},\n\};/);
});

test("parseWrap reads the first section only", () => {
  const w = parseWrap("[wrap-file]\ndirectory = lz4-1.10.0\nsource_hash = abc\n# c\n\n[provide]\nlz4 = lz4_dep\n");
  assert.equal(w.section, "wrap-file");
  assert.deepEqual(w.keys, { directory: "lz4-1.10.0", source_hash: "abc" });
});
