// The licence a recompiled cart carries.
//
// A compiled homebrew ROM contains only its author's code and permissive
// runtime libraries. A RECOMPILED cart is different: every backend under
// wat/<platform>/ (and native/genesis/) puts code ported or mechanically
// translated from the reference emulator into the cart, so the cart is under
// that emulator's licence (and also contains the code of the game it was
// recompiled from). This module names those components per platform, and
// cartLicence() builds the `licence` entry of the cart's romdev.recompile
// section (or the sync32 cart's metadata).
//
// The entry is deterministic: it depends only on the platform, the cart's
// describe() (which chip, SVP or not) and this package's version.
//
// The full licence texts are in this package's LICENSES/ directory; each
// backend directory has a NOTICE.txt naming its upstream. The pinned commits
// below must equal scripts/versions.json (a test checks it).
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VERSION = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")).version;
const text = (f) => readFileSync(path.join(PKG, "LICENSES", f), "utf8").replace(/\s+$/, "") + "\n";

const FCEUMM = "3a84a6fd0ba20dd4877c06b1d58741172148395f";
const GAMBATTE = "3262c2aa4adae8dba4f6d51cdd931c15cb11569f";
const MGBA = "6dce57eef127dc4cc292644f38196e0e7c58590c";
const GPGX = "162c3439a697ffdfa00a5d3f44af103bf671f5dc";
const SNES9X = "185488cd83aaf274752a742c94d45561cbecb7af";
const ARES = "4cb8d92b441557cb6bcaf133c4cbc7f6819b1122";
const EMSCRIPTEN = "4.0.18";

/**
 * One transplanted component: what it is, where it comes from, its licence.
 * @typedef {{name: string, url: string, commit: string, spdx: string, text: string}} Upstream
 */

/** @type {Record<string, Upstream>} */
export const UPSTREAMS = {
  fceumm: { name: "fceumm (CPU timing, PPU, APU, mappers)", url: "https://github.com/libretro/libretro-fceumm", commit: FCEUMM, spdx: "GPL-2.0-or-later", text: "GPL-2.0.txt" },
  gambatte: { name: "gambatte (CPU timing, PPU, APU, MBCs)", url: "https://github.com/libretro/gambatte-libretro", commit: GAMBATTE, spdx: "GPL-2.0-only", text: "GPL-2.0.txt" },
  blipper: { name: "blipper resampler (gambatte-libretro)", url: "https://github.com/libretro/gambatte-libretro", commit: GAMBATTE, spdx: "MIT", text: "MIT-blipper.txt" },
  mgba: { name: "mGBA 0.11 (ARM7TDMI, system, video, audio, GPIO, HLE BIOS)", url: "https://github.com/libretro/mgba", commit: MGBA, spdx: "MPL-2.0", text: "MPL-2.0.txt" },
  musl: { name: "musl libm (Emscripten's)", url: "https://github.com/emscripten-core/emscripten", commit: `tag ${EMSCRIPTEN}`, spdx: "MIT", text: "MIT-musl.txt" },
  gpgx: { name: "Genesis Plus GX (VDP, memory map, I/O, PSG, YM2612, frame loop)", url: "https://github.com/libretro/genesis-plus-gx", commit: GPGX, spdx: "LicenseRef-GenesisPlusGX", text: "LicenseRef-GenesisPlusGX.txt" },
  blip_buf: { name: "blip_buf (as shipped in Genesis Plus GX)", url: "https://github.com/libretro/genesis-plus-gx", commit: GPGX, spdx: "LGPL-2.1-or-later", text: "LGPL-2.1.txt" },
  musashi: { name: "Musashi 68000 core 3.32 (as shipped in Genesis Plus GX)", url: "https://github.com/libretro/genesis-plus-gx", commit: GPGX, spdx: "LicenseRef-Musashi", text: "LicenseRef-Musashi.txt" },
  z80: { name: "MAME z80.c 3.9 (as shipped in Genesis Plus GX)", url: "https://github.com/libretro/genesis-plus-gx", commit: GPGX, spdx: "LicenseRef-MAME-Z80", text: "LicenseRef-MAME-Z80.txt" },
  svp: { name: "SVP / SSP1601 (svp.c, ssp16.c in Genesis Plus GX)", url: "https://github.com/libretro/genesis-plus-gx", commit: GPGX, spdx: "LicenseRef-SVP-notaz", text: "LicenseRef-SVP-notaz.txt" },
  snes9x: { name: "snes9x (bus, CPU timing, DMA, PPU, SPC700, chips)", url: "https://github.com/libretro/snes9x", commit: SNES9X, spdx: "LicenseRef-snes9x", text: "LicenseRef-snes9x.txt" },
  snes_spc: { name: "snes_spc S-DSP (SPC_DSP.cpp in snes9x)", url: "https://github.com/libretro/snes9x", commit: SNES9X, spdx: "LGPL-2.1-or-later", text: "LGPL-2.1.txt" },
  spc7110: { name: "SPC7110 emulator (spc7110emu.cpp, spc7110dec.cpp in snes9x)", url: "https://github.com/libretro/snes9x", commit: SNES9X, spdx: "ISC", text: "ISC-spc7110.txt" },
  ares: { name: "ares (uPD96050 and ARM chip cores)", url: "https://github.com/ares-emulator/ares", commit: ARES, spdx: "ISC", text: "ISC-ares.txt" },
};

/** What each SPDX id means for whoever shares the cart, in one plain line. */
export const TERMS = {
  "GPL-2.0-or-later": "GPL-2.0: sharing the cart requires offering its complete corresponding source under the GPL",
  "GPL-2.0-only": "GPL-2.0: sharing the cart requires offering its complete corresponding source under the GPL",
  "MPL-2.0": "MPL-2.0: sharing the cart requires offering the source of the MPL-covered files (file-level copyleft)",
  "LGPL-2.1-or-later": "LGPL-2.1: sharing the cart requires offering the source of the LGPL part and allowing it to be rebuilt with a modified version of that part",
  "LicenseRef-GenesisPlusGX": "Genesis Plus GX licence: non-commercial, the cart may not be sold or used in a commercial product or activity",
  "LicenseRef-Musashi": "Musashi licence: non-commercial use only, its notice must stay in the cart",
  "LicenseRef-MAME-Z80": "z80.c licence: non-commercial freeware",
  "LicenseRef-SVP-notaz": "SVP code licence: free for non-commercial use only",
  "LicenseRef-snes9x": "snes9x licence: non-commercial, the cart may not be sold or used commercially, and the licence must go with every copy",
  MIT: "MIT: keep the notice",
  ISC: "ISC: keep the notice",
};

/**
 * Notices carried in the cart verbatim: the non-standard licences (their
 * conditions travel with every copy) and the permissive ones whose notice
 * must be in all copies. The standard GPL / LGPL / MPL texts are named by
 * SPDX id and found in LICENSES/ (licenceTexts). Genesis Plus GX's file goes
 * on to list third-party libraries a cart does not contain; the cart keeps
 * its own licence block (up to the first separator line).
 */
const IN_CART = new Set(["gpgx", "musashi", "z80", "svp", "snes9x", "blipper", "musl", "spc7110", "ares"]);
const noticeText = (k) => {
  const t = text(UPSTREAMS[k].text);
  if (k === "gpgx") return t.slice(0, t.indexOf("\n-----")).trim() + "\n";
  // musl's file goes on to list its authors: the cart keeps the MIT block
  // and the notice of the FreeBSD msun files its sin/cos come from
  if (k === "musl") return t.slice(0, t.indexOf("Authors/contributors include:")).trim() + "\n\n" + text("msun-Sun.txt");
  return t;
};

/**
 * The components a cart of `platform` contains.
 * @param {string} platform   sms, gg, nes, gb, gbc, genesis/md/megadrive, snes, gba, or "sync32-genesis"
 * @param {object} [d]        the backend's describe() (snes: coprocessor, chipImpl; genesis: svp)
 * @param {object} [opts]     the recompile options (genesis: audio)
 * @returns {string[]} keys of UPSTREAMS
 */
export function cartComponents(platform, d = {}, opts = {}) {
  switch (platform) {
    case "nes": return ["fceumm"];
    case "gb": case "gbc": return ["gambatte", "blipper"];
    case "gba": return ["mgba", "musl"];
    case "sms": case "gg": return ["gpgx", "blip_buf"];
    case "genesis": case "md": case "megadrive":
      return ["gpgx", "musashi", "z80", ...(opts.audio !== false ? ["blip_buf"] : []), ...(d.svp ? ["svp"] : [])];
    case "sync32-genesis": return ["gpgx", "musashi", "z80", "blip_buf"];
    case "snes": {
      const c = ["snes9x", "snes_spc"];
      if (d.coprocessor === "SPC7110") c.push("spc7110");
      if (d.coprocessor === "CX4") c.push("musl");
      if (d.chipImpl === "ares") c.push("ares");
      return c;
    }
    default: throw new Error(`licence: no recompiler backend for platform '${platform}'`);
  }
}

/** Where the corresponding source of each platform's transplanted code lives in this package. */
const SOURCE_DIR = {
  nes: "src/analysis/recompile/wat/nes/",
  gb: "src/analysis/recompile/wat/gb/",
  gba: "src/analysis/recompile/wat/gba/",
  sms: "src/analysis/recompile/wat/sms/",
  genesis: "src/analysis/recompile/wat/genesis/ and wat/sms/ (sound)",
  "sync32-genesis": "src/analysis/recompile/native/genesis/ and wat/genesis/",
  snes: "src/analysis/recompile/wat/snes/",
};
const CANON = { gg: "sms", gbc: "gb", md: "genesis", megadrive: "genesis" };

/**
 * The `licence` entry of a recompiled cart.
 * @param {string} platform
 * @param {object} [d]     describe() of the cart
 * @param {object} [opts]  recompile options
 * @returns {{spdx: string, terms: string[], upstream: {name: string, url: string, commit: string, spdx: string}[], source: string, licenceTexts: string, romCode: string, notices?: string[]}}
 */
export function cartLicence(platform, d = {}, opts = {}) {
  const keys = cartComponents(platform, d, opts);
  const ups = keys.map((k) => UPSTREAMS[k]);
  const ids = [...new Set(ups.map((u) => u.spdx))];
  const notices = keys.filter((k) => IN_CART.has(k)).map(noticeText);
  return {
    spdx: ids.join(" AND "),
    terms: ids.map((id) => TERMS[id]),
    upstream: ups.map(({ name, url, commit, spdx }) => ({ name, url, commit, spdx })),
    source: `romdevtools ${VERSION} (npm), ${SOURCE_DIR[CANON[platform] || platform]}`,
    licenceTexts: `romdevtools ${VERSION}, LICENSES/`,
    romCode: "this cart also contains the code of the ROM it was recompiled from (romSha1): share it only with that game's owner's permission",
    ...(notices.length ? { notices } : {}),
  };
}
