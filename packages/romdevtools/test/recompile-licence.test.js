// Every recompiled cart names the emulator code it carries and that code's
// licence (src/analysis/recompile/licence.js): built for real, per platform,
// from tiny synthetic ROMs (never commercial ones), with the entry read back
// out of the cart's romdev.recompile section.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recompileToWasmcart } from "../src/analysis/recompile/wat/build.js";
import { readCustomSections } from "../src/analysis/recompile/wat/cart-abi.js";
import { cartLicence, cartComponents, UPSTREAMS, TERMS } from "../src/analysis/recompile/licence.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const VERSION = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")).version;

const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const be32 = (v) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];

/** Smallest ROM each backend accepts: a header and a spin loop at the entry point. */
const ROMS = {
  // NROM-128: jmp $C000 at $C000, every vector -> $C000
  nes: () => {
    const r = new Uint8Array(16 + 0x4000 + 0x2000);
    r.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0], 0);
    r.set([0x4c, 0x00, 0xc0], 16);
    for (const v of [0x3ffa, 0x3ffc, 0x3ffe]) r.set([0x00, 0xc0], 16 + v);
    return r;
  },
  // 32KB ROM-only: nop; jp $0150 at $0100, jr $ at $0150, header checksum
  gb: () => {
    const r = new Uint8Array(0x8000);
    r.set([0x00, 0xc3, 0x50, 0x01], 0x100);
    r.set([0x18, 0xfe], 0x150);
    let s = 0;
    for (let i = 0x134; i <= 0x14c; i++) s = (s - r[i] - 1) & 0xff;
    r[0x14d] = s;
    return r;
  },
  // 32KB: di; jr $ at 0, the TMR SEGA header
  sms: () => {
    const r = new Uint8Array(0x8000);
    r.set([0xf3, 0x18, 0xfe], 0);
    r.set([...Buffer.from("TMR SEGA")], 0x7ff0);
    r[0x7fff] = 0x4c;
    return r;
  },
  // 64KB: SSP, reset at $200 (bra.s $), header text
  genesis: () => {
    const r = new Uint8Array(0x10000);
    r.set(be32(0x00fffe00), 0);
    for (let v = 1; v < 64; v++) r.set(be32(0x200), v * 4);
    r.set([...Buffer.from("SEGA MEGA DRIVE ")], 0x100);
    r.set([...Buffer.from("SYNTHETIC TEST CART")], 0x150);
    r.set([...Buffer.from("JUE".padEnd(16, " "))], 0x1f0);
    r.set([0x60, 0xfe], 0x200);
    return r;
  },
  // 32KB LoROM: bra $ at $8000, reset vector $8000
  snes: () => {
    const r = new Uint8Array(0x8000);
    r.set([...Buffer.from("SYNTHETIC CART".padEnd(21, " "))], 0x7fc0);
    r.set([0x20, 0x00, 0x08, 0x00], 0x7fd5);
    r.set([0xff, 0xff], 0x7fdc);
    r.set([0x00, 0x80], 0x7ffc);
    r.set([0x80, 0xfe], 0);
    return r;
  },
  // 4KB: b . at the entry, header with its complement check
  gba: () => {
    const r = new Uint8Array(0x1000);
    r.set(le32(0xeafffffe), 0);
    r.set([...Buffer.from("SYNTHETIC")], 0xa0);
    r[0xb2] = 0x96;
    let c = 0;
    for (let i = 0xa0; i < 0xbd; i++) c = (c - r[i]) & 0xff;
    r[0xbd] = (c - 0x19) & 0xff;
    return r;
  },
};

/** What each platform's cart must declare: SPDX expression, upstream repos, notice snippets. */
const EXPECT = {
  nes: { spdx: "GPL-2.0-or-later", repos: ["libretro-fceumm"], notices: [] },
  gb: { spdx: "GPL-2.0-only AND MIT", repos: ["gambatte-libretro"], notices: ["Hans-Kristian Arntzen"] },
  sms: { spdx: "LicenseRef-GenesisPlusGX AND LGPL-2.1-or-later", repos: ["genesis-plus-gx"], notices: ["Eke-Eke", "may not be sold"] },
  genesis: {
    spdx: "LicenseRef-GenesisPlusGX AND LicenseRef-Musashi AND LicenseRef-MAME-Z80 AND LGPL-2.1-or-later",
    repos: ["genesis-plus-gx"], notices: ["Eke-Eke", "MUSASHI", "Copyright Karl Stenerud", "Juergen Buchmueller"],
  },
  snes: { spdx: "LicenseRef-snes9x AND LGPL-2.1-or-later", repos: ["snes9x"], notices: ["for non-commercial purposes"] },
  gba: { spdx: "MPL-2.0 AND MIT", repos: ["mgba", "emscripten"], notices: ["Rich Felker", "Sun Microsystems"] },
};

/** @param {string} platform */
async function builtLicence(platform, dir, opts = {}) {
  const out = path.join(dir, `${platform}.wasm`);
  await recompileToWasmcart({ platform, rom: ROMS[platform](), outputPath: out, emit: "wasm", options: opts });
  const [sec] = readCustomSections(new Uint8Array(readFileSync(out)));
  return { out, licence: JSON.parse(Buffer.from(sec).toString("utf8")).licence };
}

for (const platform of Object.keys(EXPECT)) {
  test(`a recompiled ${platform} cart carries its reference core's licence`, async (t) => {
    const dir = mkdtempSync(path.join(HERE, ".licence-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { licence: l } = await builtLicence(platform, dir);
    const e = EXPECT[platform];
    assert.ok(l, "the section has a licence entry");
    assert.equal(l.spdx, e.spdx);
    assert.deepEqual(l.terms, l.spdx.split(" AND ").map((id) => TERMS[id]), "one plain line per licence");
    for (const repo of e.repos) assert.ok(l.upstream.some((u) => u.url.endsWith("/" + repo)), `upstream ${repo}`);
    for (const u of l.upstream) assert.match(u.commit, /^([0-9a-f]{40}|tag \d+\.\d+\.\d+)$/, `${u.name} is pinned`);
    assert.match(l.source, new RegExp(`^romdevtools ${VERSION.replace(/\./g, "\\.")} \\(npm\\), src/analysis/recompile/`));
    assert.equal(l.licenceTexts, `romdevtools ${VERSION}, LICENSES/`);
    assert.match(l.romCode, /game's owner/);
    const all = (l.notices || []).join("\n");
    for (const s of e.notices) assert.ok(all.includes(s), `notice mentions ${s}`);
    if (!e.notices.length) assert.equal(l.notices, undefined, "a GPL-only cart names its licence, it carries no notice block");
  });
}

test("a Game Boy Color and a Game Gear cart are licensed as their backend", () => {
  assert.equal(cartLicence("gbc").spdx, cartLicence("gb").spdx);
  assert.equal(cartLicence("gg").spdx, cartLicence("sms").spdx);
  assert.equal(cartLicence("md").spdx, cartLicence("genesis").spdx);
});

test("the licence follows what the cart contains: SNES chips, SVP, Genesis without sound", () => {
  assert.equal(cartLicence("snes", { coprocessor: "SPC7110" }).spdx, "LicenseRef-snes9x AND LGPL-2.1-or-later AND ISC");
  assert.match(cartLicence("snes", { coprocessor: "SPC7110" }).notices.join(""), /byuu and neviksti/);
  assert.equal(cartLicence("snes", { coprocessor: "CX4" }).spdx, "LicenseRef-snes9x AND LGPL-2.1-or-later AND MIT");
  const ares = cartLicence("snes", { coprocessor: "ST018", chipImpl: "ares" });
  assert.equal(ares.spdx, "LicenseRef-snes9x AND LGPL-2.1-or-later AND ISC");
  assert.match(ares.notices.join(""), /ares team, Near et al/);
  assert.equal(cartLicence("snes", { coprocessor: "ST018" }).spdx, "LicenseRef-snes9x AND LGPL-2.1-or-later", "snes9x's own ST018 is not ares");
  assert.match(cartLicence("genesis", { svp: true }).spdx, /LicenseRef-SVP-notaz$/);
  assert.match(cartLicence("genesis", { svp: true }).notices.join(""), /notaz/);
  assert.ok(!cartComponents("genesis", {}, { audio: false }).includes("blip_buf"));
  assert.throws(() => cartLicence("toy"), /no recompiler backend/);
});

test("the same ROM builds the same cart, licence entry included", async (t) => {
  const dir = mkdtempSync(path.join(HERE, ".licence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = readFileSync((await builtLicence("nes", dir)).out);
  const b = readFileSync((await builtLicence("nes", dir)).out);
  assert.ok(a.equals(b));
});

test("a sync32 Genesis cart's metadata carries the same licence", async () => {
  const { emitProject } = await import("../src/analysis/recompile/native/genesis/index.js");
  const p = await emitProject(ROMS.genesis());
  assert.deepEqual(p.meta.licence, cartLicence("sync32-genesis"));
  assert.equal(p.meta.licence.spdx, EXPECT.genesis.spdx);
  assert.ok(p.files["rd_meta.c"].includes("LicenseRef-Musashi"));
});

test("pins equal scripts/versions.json, texts exist, every backend directory has its NOTICE.txt", () => {
  const v = JSON.parse(readFileSync(path.join(PKG, "scripts", "versions.json"), "utf8"));
  const core = { fceumm: "fceumm", gambatte: "gambatte", blipper: "gambatte", mgba: "mgba", gpgx: "genesis_plus_gx", blip_buf: "genesis_plus_gx", musashi: "genesis_plus_gx", z80: "genesis_plus_gx", svp: "genesis_plus_gx", snes9x: "snes9x", snes_spc: "snes9x", spc7110: "snes9x", ares: "ares" };
  for (const [k, u] of Object.entries(UPSTREAMS)) {
    assert.ok(existsSync(path.join(PKG, "LICENSES", u.text)), `LICENSES/${u.text}`);
    assert.ok(TERMS[u.spdx], `${u.spdx} has a plain-language line`);
    if (k === "musl") assert.equal(u.commit, `tag ${v.emsdk}`);
    else assert.equal(u.commit, v.cores[core[k]].commit, `${k} pin`);
  }
  for (const dir of ["wat/nes", "wat/gb", "wat/gba", "wat/sms", "wat/genesis", "wat/snes", "native/genesis"]) {
    const f = path.join(PKG, "src", "analysis", "recompile", dir, "NOTICE.txt");
    assert.ok(existsSync(f), `${dir}/NOTICE.txt`);
  }
});
