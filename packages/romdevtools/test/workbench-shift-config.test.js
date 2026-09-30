// The faithful-configuration gate (`shift config verify`): every shared
// symbol at the same address, every shared section placed the same way, and
// optionally byte-identical images. Ported from the workbench's own tests;
// fixtures are handcrafted map excerpts. The upstream live-conformance
// classes replay commercial projects' links and are not ported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseLdMap } from "../src/decomp/workbench/ldmap.js";
import { SHIFT_METRICS_BY_KEY } from "../src/decomp/workbench/schema.js";
import { CONFIG_VERIFY_SCHEMA, FAITHFUL_CHECKS, verifyFaithful, verifyLines } from "../src/decomp/workbench/shift-config.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { ValueError } from "../src/decomp/workbench/py.js";

const PINNED_MAP = `
Linker script and memory map

.header         0x00000000       0x40
 .data          0x00000000       0x40 build/header.o

.main           0x80000400       0x80 load address 0x00000040
 .text          0x80000400       0x80 build/code.o
                0x80000400                entrypoint
                0x80000440                func_a

.main_bss       0x80000480       0x40
 .bss           0x80000480       0x40 build/code.o
                0x80000480                main_BSS_START
`;
const IMAGE = Buffer.concat([Buffer.from([...Array(0x40).keys()]), Buffer.from([...Array(0x40).keys()])]);

function candidate({ moved = null, size = 0x80, load = 0x40, renamed = null, dropped = null } = {}) {
  let text = PINNED_MAP;
  if (moved !== null) text = text.replace(`0x80000440                ${moved}`, `0x80000450                ${moved}`);
  if (size !== 0x80) text = text.replace("0x80000400       0x80 load", `0x80000400       0x${size.toString(16)} load`);
  if (load !== 0x40) text = text.replace("load address 0x00000040", `load address 0x${load.toString(16).padStart(8, "0")}`);
  if (renamed !== null) text = text.replaceAll("func_a", renamed);
  if (dropped !== null) text = text.split("\n").filter((l) => !l.includes(dropped)).join("\n");
  return text;
}
const verify = (text, extra = {}) => verifyFaithful({ pinned: parseLdMap(PINNED_MAP, { path: "pinned.map" }), candidate: parseLdMap(text, { path: "candidate.map" }), ...extra });
const faithful = () => verify(PINNED_MAP, { pinned_image: IMAGE, candidate_image: IMAGE, pinned_image_path: "pinned.z64", candidate_image_path: "candidate.z64" });

test("a pair that matches is faithful, and every check reports what it saw", () => {
  const f = faithful();
  assert.equal(f.faithful, true);
  assert.equal(f.differences, 0);
  assert.deepEqual([f.shared_symbols, f.shared_sections, f.symbols_moved, f.sections_diverged, f.image_identical], [3, 3, 0, 0, true]);
  assert.equal(f.first_moved_symbol, null);
  assert.equal(f.first_section_divergence, null);
  assert.equal(f.image_first_difference, null);
});

test("the check table travels with the report, and every emitted key is registered", () => {
  const p = faithful().asDict({ limit: 5 });
  assert.equal(p.schema, CONFIG_VERIFY_SCHEMA);
  assert.deepEqual(p.faithful_checks.map((c) => c.name), FAITHFUL_CHECKS.map((c) => c.name));
  assert.deepEqual(p.allowed_deltas, [0]);
  const emitted = new Set(Object.keys(p));
  for (const k of ["moved_symbols", "section_divergences", "faithful_checks"]) for (const row of p[k]) for (const x of Object.keys(row)) emitted.add(x);
  for (const k of emitted) assert.ok(k in SHIFT_METRICS_BY_KEY, `unregistered key ${k}`);
});

test("divergences: a moved symbol, a resized section, a moved AT(), a rename, a dropped section", () => {
  let f = verify(candidate({ moved: "func_a" }));
  assert.equal(f.faithful, false);
  assert.equal(f.symbols_moved, 1);
  assert.deepEqual(f.first_moved_symbol, ["func_a", 0x80000440, 0x80000450]);
  f = verify(candidate({ size: 0x90 }));
  assert.equal(f.faithful, false);
  let d = f.first_section_divergence;
  assert.deepEqual([d.name, d.field, d.pinned, d.candidate], [".main", "size", 0x80, 0x90]);
  d = verify(candidate({ load: 0x60 })).first_section_divergence;
  assert.deepEqual([d.field, d.pinned, d.candidate], ["load_address", 0x40, 0x60]);
  f = verify(candidate({ renamed: "func_b" }));
  assert.equal(f.faithful, false);
  assert.deepEqual(f.symbols_only_in_pinned, ["func_a"]);
  assert.deepEqual(f.symbols_only_in_candidate, ["func_b"]);
  assert.equal(f.symbols_moved, 0);
  f = verify(candidate({ dropped: ".main_bss" }));
  assert.ok(f.sections_only_in_pinned.includes(".main_bss"));
  assert.equal(f.faithful, false);
});

test("images: first differing byte, a different length, uniform trailing padding is still a difference", () => {
  const other = Buffer.from(IMAGE);
  other[0x33] ^= 0xFF;
  let f = verify(PINNED_MAP, { pinned_image: IMAGE, candidate_image: other });
  assert.equal(f.faithful, false);
  assert.equal(f.image_identical, false);
  assert.equal(f.image_first_difference, 0x33);
  f = verify(PINNED_MAP, { pinned_image: IMAGE, candidate_image: Buffer.concat([IMAGE, Buffer.alloc(16)]) });
  assert.equal(f.image_identical, false);
  assert.equal(f.candidate_image_bytes, IMAGE.length + 16);
  assert.equal(f.faithful, false);
});

test("one image alone is refused; no images leaves the check off; the report says not-checked", () => {
  assert.throws(() => verify(PINNED_MAP, { pinned_image: IMAGE }), (e) => e instanceof ValueError && e.message.includes("go together"));
  const f = verify(PINNED_MAP);
  assert.equal(f.image_checked, false);
  assert.equal(f.image_identical, null);
  assert.equal(f.faithful, true);
  assert.ok(verifyLines(verify(PINNED_MAP), { limit: 5 }).join("\n").includes("image=not-checked"));
});

test("rendering: verdict first, faithful says so, names the other command, prints every check and caps", () => {
  let text = verifyLines(verify(candidate({ moved: "func_a" })), { limit: 5 }).join("\n");
  assert.ok(text.includes("faithful=NO") && text.includes("first divergent symbol: func_a"));
  text = verifyLines(verify(PINNED_MAP), { limit: 5 }).join("\n");
  assert.ok(text.includes("faithful=yes") && text.includes("differences=0") && text.includes("shift rehearse"));
  for (const c of FAITHFUL_CHECKS) assert.ok(text.includes(`  ${c.name}:`));
  const broken = PINNED_MAP.split("\n").map((l) => l.replace("0x80000440", "0x80000450")).join("\n");
  assert.ok(verifyLines(verify(broken), { limit: 0 }).join("\n").includes("moved symbols (0 of 1, --limit)"));
});

function commandFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-shiftcfg-"));
  writeFileSync(path.join(root, "pinned.map"), PINNED_MAP);
  writeFileSync(path.join(root, "candidate.map"), PINNED_MAP);
  writeFileSync(path.join(root, "moved.map"), candidate({ moved: "func_a" }));
  writeFileSync(path.join(root, "pinned.z64"), IMAGE);
  writeFileSync(path.join(root, "candidate.z64"), IMAGE);
  return root;
}
const runVerify = (...a) => runCommand(["shift", "config", "verify", "--pager", "never", "--width", "unlimited", ...a]);

test("command exit contract: 0 faithful, 3 not, JSON keeps the status, census composes", async () => {
  const root = commandFixture();
  const p = (n) => path.join(root, n);
  try {
    let r = await runVerify("--pinned-map", p("pinned.map"), "--candidate-map", p("candidate.map"), "--pinned-image", p("pinned.z64"), "--candidate-image", p("candidate.z64"));
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("faithful=yes"));
    r = await runVerify("--pinned-map", p("pinned.map"), "--candidate-map", p("moved.map"));
    assert.equal(r.code, 3);
    assert.ok(r.stdout.includes("faithful=NO"));
    r = await runVerify("--pinned-map", p("pinned.map"), "--candidate-map", p("moved.map"), "--json");
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.schema, CONFIG_VERIFY_SCHEMA);
    assert.equal(payload.faithful, false);
    assert.equal(r.code, 3);
    r = await runVerify("--pinned-map", p("pinned.map"), "--candidate-map", p("candidate.map"), "--census", "symbols_moved=0,faithful=true");
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("census: PASS faithful=true"));
    r = await runVerify("--pinned-map", p("pinned.map"), "--candidate-map", p("candidate.map"), "--census", "shared_symbols=99");
    assert.equal(r.code, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("command refusals: one image alone, a missing map", async () => {
  const root = commandFixture();
  const p = (n) => path.join(root, n);
  try {
    let r = await runVerify("--pinned-map", p("pinned.map"), "--candidate-map", p("candidate.map"), "--pinned-image", p("pinned.z64"));
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("go together"));
    r = await runVerify("--pinned-map", p("absent.map"), "--candidate-map", p("candidate.map"));
    assert.equal(r.code, 2);
    assert.ok(r.stderr.startsWith("error: "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
