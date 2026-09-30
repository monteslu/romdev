// A handcrafted base link and its relinked twin for the shift-rehearse
// tests: every census class has one word, every checksum outcome one pair,
// and the tier x moved matrix is populated by hand. No bytes from any ROM.
// Port of the workbench's own rehearse fixture, parameterised by delta.
import { parseLdMap } from "../../../src/decomp/workbench/ldmap.js";
import { defaultPinModel } from "../../../src/decomp/workbench/pins.js";
import { buildRehearsal } from "../../../src/decomp/workbench/shift-rehearse.js";

export const INSERTION_VRAM = 0x80000410;
export const INSERTION_ROM = 0x50;
export const TEXT_SYMBOLS = [["entrypoint", 0x80000400], ["func_a", 0x80000410], ["fn_inert", 0x80000430], ["fn_tracked", 0x80000438], ["fn_stale", 0x80000440], ["fn_orphan", 0x80000448]];
export const DATA_SYMBOLS = [["gData", 0x80000460], ["gPointerTable", 0x80000470], ["gTail", 0x80000480], ["gLater", 0x80000490], ["gInertSum", 0x800004A0],
  ["gTrackedSum", 0x800004A4], ["gStaleSum", 0x800004A8], ["gOrphanSum", 0x800004AC]];
export const BSS_SYMBOLS = [["main_BSS_END", 0x80000500]];
export const CHECKSUM_PAIRS = [["fn_inert", "gInertSum"], ["fn_tracked", "gTrackedSum"], ["fn_stale", "gStaleSum"], ["fn_orphan", "gOrphanSum"]];
export const CRC_WORDS = [0x10, 0x14];
export const BLOBS = [".boot"];

const h8 = (v) => (v >>> 0).toString(16).padStart(8, "0");
const hx = (v) => v.toString(16);

export function renderMap(delta, { anomaly = null } = {}) {
  const placed = (name, address) => (address < INSERTION_VRAM ? address : name === anomaly ? address + Math.floor(delta / 2) : address + delta);
  const lines = ["", "Linker script and memory map", "", ".header         0x00000000       0x20", " .data          0x00000000       0x20 build/header.o", "",
    ".boot           0x00000020       0x20", " .data          0x00000020       0x20 build/boot.bin.o", "",
    `.main           0x80000400       0x${hx(0xC0 + delta)} load address 0x00000040`, ` .text          0x80000400       0x${hx(0x60 + delta)} build/entry.o`];
  for (const [n, a] of TEXT_SYMBOLS) lines.push(`                0x${h8(placed(n, a))}                ${n}`);
  lines.push(` .data          0x${h8(0x80000460 + delta)}       0x60 build/code.o`);
  for (const [n, a] of DATA_SYMBOLS) lines.push(`                0x${h8(placed(n, a))}                ${n}`);
  lines.push("", `.main_bss       0x${h8(0x800004C0 + delta)}       0x40`, ` .bss           0x${h8(0x800004C0 + delta)}       0x40 build/code.o`);
  for (const [n, a] of BSS_SYMBOLS) lines.push(`                0x${h8(placed(n, a))}                ${n}`);
  lines.push("");
  return lines.join("\n");
}

export function baseWords() {
  const w = Array(64).fill(0);
  const put = (o, v) => { w[o / 4] = v >>> 0; };
  put(0x00, 0x80371240); put(0x04, 0x0000000F); put(0x10, 0xA1B2C3D4); put(0x14, 0xE5F60718); put(0x18, 0x80000460);
  put(0x20, 0x80000474); put(0x24, 0x80000470);
  put(0x40, 0x3C088000); put(0x44, 0x24080010); put(0x48, 0x0C000104);
  put(0x50, 0x3C088000); put(0x54, 0x25080460); put(0x58, 0x3C018000); put(0x5C, 0x8C22FFF0); put(0x60, 0x11223344);
  put(0x78, 0x0C000110); put(0x80, 0x0C000104);
  put(0xA0, 0x80000470); put(0xA4, 0x80000474); put(0xA8, 0x80000490); put(0xB0, 0x80000480);
  put(0xE0, 0x00001111); put(0xE4, 0x00002222); put(0xE8, 0x00003333); put(0xEC, 0x00004444);
  return w;
}

export function shiftedWords(delta, { extra_unexplained = false } = {}) {
  const w = baseWords();
  const put = (o, v) => { w[o / 4] = v >>> 0; };
  put(0x10, 0x11223344); put(0x14, 0x55667788); put(0x18, 0x80000460 + delta); put(0x48, 0x0C000104 + delta / 4);
  put(0x54, 0x25080460 + delta); put(0x58, 0x3C018001); put(0x5C, (0x8C220000 | ((0xFFF0 + delta) & 0xFFFF)) >>> 0); put(0x60, 0x55667788);
  put(0x78, 0x0C000110 + delta / 4); put(0x80, 0x0C000104 + delta / 4); put(0xA0, 0x80000470 + delta); put(0xB0, 0x80000480 + delta);
  put(0xE4, 0x00002233); put(0xEC, 0x00004455);
  if (extra_unexplained) put(0x64, 0xDEADBEEF);
  return w;
}

export const pack = (words) => Buffer.concat(words.map((v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; }));
export const baseImage = () => pack(baseWords());
export function padded(words, delta) {
  const split = INSERTION_ROM / 4;
  return [...words.slice(0, split), ...Array(delta / 4).fill(0), ...words.slice(split)];
}
export const shiftedImage = (delta, opts = {}) => pack(padded(shiftedWords(delta, opts), delta));
export const baseMap = () => parseLdMap(renderMap(0), { path: "base.map" });
export const shiftedMap = (delta, opts = {}) => parseLdMap(renderMap(delta, opts), { path: "shifted.map" });

export function rehearse(delta = 0x10, { anchor = null, anomaly = null, extra_unexplained = false, checksum_pairs = CHECKSUM_PAIRS, crc_words = CRC_WORDS } = {}) {
  return buildRehearsal({ base_ldmap: baseMap(), base_image: baseImage(), shifted_ldmap: shiftedMap(delta, { anomaly }), shifted_image: shiftedImage(delta, { extra_unexplained }),
    delta, anchor, blobs: BLOBS, crc_words, checksum_pairs, model: defaultPinModel(), base_map_path: "base.map", base_image_path: "base.z64",
    shifted_map_path: "shifted.map", shifted_image_path: "shifted.z64" });
}

export function rehearseTracking(delta, offsets) {
  const w = shiftedWords(delta);
  for (const o of offsets) w[o / 4] = (baseWords()[o / 4] + delta) >>> 0;
  return buildRehearsal({ base_ldmap: baseMap(), base_image: baseImage(), shifted_ldmap: shiftedMap(delta), shifted_image: pack(padded(w, delta)), delta,
    blobs: BLOBS, crc_words: CRC_WORDS, checksum_pairs: CHECKSUM_PAIRS, model: defaultPinModel(), base_map_path: "base.map", base_image_path: "base.z64",
    shifted_map_path: "shifted.map", shifted_image_path: "shifted.z64" });
}

export const statusFor = (found, fn) => found.checksums.find((c) => c.function === fn).status;
