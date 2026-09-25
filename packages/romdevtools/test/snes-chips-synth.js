// Test support for the SNES recompiler's chip tests (snes-chips.test.js):
// synthetic carts that drive a coprocessor's registers with a list of
// reads and writes and store every byte read at $7E0100 onward, so the
// cart's work RAM can be compared with what snes9x leaves there. Synthetic
// programs only (never commercial code).
//
// Plain JS ESM.

/**
 * @typedef {["w", number, number] | ["r", number] | ["r16", number] | ["w16", number, number] | ["frames", number]} ChipOp
 *   w: 8-bit store of a value to a 24-bit address; r: 8-bit load, kept;
 *   r16 / w16: the same as one 16-bit access (lo byte kept first);
 *   frames: wait for that many NMIs (the chip's clock runs meanwhile)
 */

/**
 * 65816 code for `ops` (8-bit A, native mode), then `$A5` at $7E00FF and a
 * spin. Every read lands at $7E0100 + k.
 * @param {ChipOp[]} ops
 */
export function chipProgram(ops) {
  const out = [0x78, 0x18, 0xfb, 0xe2, 0x30];   // sei / clc / xce / sep #$30
  let k = 0;
  const long = (a) => [a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff];
  const keep = () => { const a = 0x7e0100 + k; k++; return long(a); };
  for (const op of ops) {
    switch (op[0]) {
      case "w": out.push(0xa9, op[2] & 0xff, 0x8f, ...long(op[1])); break;
      case "r": out.push(0xaf, ...long(op[1]), 0x8f, ...keep()); break;
      case "w16": out.push(0xc2, 0x20, 0xa9, op[2] & 0xff, (op[2] >> 8) & 0xff, 0x8f, ...long(op[1]), 0xe2, 0x20); break;
      case "r16": { const lo = keep(); keep(); out.push(0xc2, 0x20, 0xaf, ...long(op[1]), 0x8f, ...lo, 0xe2, 0x20); break; }
      case "frames":
        // NMI on; wai n times; NMI off (the handler is an rti at $8000 + 0x7F00)
        out.push(0xa9, 0x80, 0x8d, 0x00, 0x42);
        for (let i = 0; i < op[1]; i++) out.push(0xcb);
        out.push(0x9c, 0x00, 0x42);
        break;
      default: throw new Error(`chipProgram: unknown op ${op[0]}`);
    }
  }
  out.push(0xa9, 0xa5, 0x8f, 0xff, 0x00, 0x7e, 0x80, 0xfe);
  return { code: out, reads: k };
}

/**
 * A LoROM or HiROM image with `code` at $00:8000, an `rti` NMI handler,
 * and the header fields that pick the chip (snes9x InitROM's ROMType /
 * ROMSpeed identifier and friends).
 * @param {object} o
 * @param {number[]} o.code
 * @param {boolean} [o.hirom]
 * @param {number} [o.banks]     32KB banks (64KB for HiROM counts as two)
 * @param {number} o.mapMode     header $xFD5 (ROMSpeed)
 * @param {number} o.romType     header $xFD6 (ROMType)
 * @param {number} [o.romSize]   header $xFD7
 * @param {number} [o.sram]      header $xFD8
 * @param {Record<number, number>} [o.header]  other header bytes by offset from $xFB0
 * @param {string} [o.title]
 */
export function chipImage({ code, hirom = false, banks = 16, mapMode, romType, romSize, sram = 0, header = {}, title = "CHIP SYNTHETIC TEST  " }) {
  const img = new Uint8Array(banks * 0x8000).fill(0xea);
  const codeAt = hirom ? 0x8000 : 0;
  img.set(code, codeAt);
  img[codeAt + 0x7f00] = 0x40;   // NMI: rti at $8000 + $7F00 ($FF00)
  const h = hirom ? 0xffb0 : 0x7fb0;
  for (let i = 0; i < 21; i++) img[h + 0x10 + i] = title.charCodeAt(i);
  img[h + 0x25] = mapMode;
  img[h + 0x26] = romType;
  img[h + 0x27] = romSize ?? Math.max(8, Math.ceil(Math.log2(img.length / 1024)));
  img[h + 0x28] = sram;
  img[h + 0x29] = 0x01;
  img[h + 0x2a] = 0x33;
  for (const [o, v] of Object.entries(header)) img[h + Number(o)] = v;
  const vec = (o, a) => { img[h + o] = a & 0xff; img[h + o + 1] = a >> 8; };
  vec(0x4c, 0x8000);   // RESET $FFFC
  vec(0x3a, 0xff00);   // native NMI $FFEA
  vec(0x3e, 0x8000);   // native IRQ $FFEE
  // checksum as snes9x computes it over the whole image
  img[h + 0x2c] = 0; img[h + 0x2d] = 0; img[h + 0x2e] = 0; img[h + 0x2f] = 0;
  let sum = 0;
  for (const b of img) sum = (sum + b) & 0xffff;
  sum = (sum + 0x1fe) & 0xffff;
  img[h + 0x2c] = (sum ^ 0xffff) & 0xff; img[h + 0x2d] = (sum ^ 0xffff) >> 8;
  img[h + 0x2e] = sum & 0xff; img[h + 0x2f] = sum >> 8;
  return img;
}

const W = (a, ...vals) => vals.map((v) => ["w", a, v]);
/** n reads of one port */
const R = (a, n = 1) => Array.from({ length: n }, () => ["r", a]);
/** n reads of consecutive addresses */
const Rs = (a, n) => Array.from({ length: n }, (_, i) => ["r", a + i]);

/**
 * The chip cases snes-chips.test.js runs: each a header that picks the chip
 * (snes9x InitROM) and a register script through its window. The expected
 * bytes live in the test (read from snes9x after the same frames).
 * @type {Record<string, {image: object, ops: ChipOp[], frames?: number}>}
 */
export const CHIP_CASES = {
  // DSP-1, LoROM <= 1MB: M_DSP1_LOROM_S, data $20:8000, status $20:C000
  "DSP-1": {
    image: { mapMode: 0x20, romType: 0x03 },
    ops: [
      ...R(0x20c000),
      ...W(0x208000, 0x00, 0x34, 0x12, 0x78, 0x56), ...R(0x20c000), ...R(0x208000, 2),     // Op00 multiply
      ...W(0x208000, 0x04, 0x00, 0x20, 0x00, 0x40), ...R(0x208000, 4),                     // Op04 triangle
      ...W(0x208000, 0x10, 0x34, 0x12, 0x03, 0x00), ...R(0x208000, 4),                     // Op10 inverse
      ...W(0x208000, 0x01, 0x00, 0x10, 0x20, 0x00, 0x40, 0x00, 0x60, 0x00),                // Op01 attitude A
      ...W(0x208000, 0x0d, 0x00, 0x10, 0x00, 0x20, 0x00, 0x30), ...R(0x208000, 6),         // Op0D objective
      ...W(0x208000, 0x02, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x80, 0x00), ...R(0x208000, 8), // Op02 projection params
      ...W(0x208000, 0x0a, 0x20, 0x00), ...R(0x208000, 10), ["r16", 0x208000],              // Op0A raster stream
      ...W(0x208000, 0x1f, 0x00, 0x00), ...R(0x208000, 8),                                 // Op1F data ROM dump
    ],
  },
  // DSP-1, HiROM: M_DSP1_HIROM, data $00:6000, status $00:7000
  "DSP-1 HiROM": {
    image: { hirom: true, banks: 32, mapMode: 0x31, romType: 0x03 },
    ops: [
      ...R(0x007000),
      ...W(0x006000, 0x00, 0x11, 0x11, 0x22, 0x22), ...R(0x006000, 2),
      ...W(0x806000, 0x04, 0x00, 0x60, 0x00, 0x30), ...R(0x806000, 4), ...R(0x807000),
      ["w16", 0x006000, 0x0010], ["w16", 0x006000, 0x0034], ["w16", 0x006000, 0x0002], ["r16", 0x006000], ["r16", 0x006000],
    ],
  },
  // DSP-2: M_DSP2_LOROM, $20-$3F:6000-6FFF and 8000-BFFF
  "DSP-2": {
    image: { mapMode: 0x20, romType: 0x05 },
    ops: [
      ...W(0x206000, 0x09, 0x34, 0x12, 0x78, 0x56), ...R(0x206000, 4), ...R(0x20c000),    // Op09 multiply; $C000 is not the chip
      ...W(0x208000, 0x01, ...Array.from({ length: 32 }, (_, i) => (i * 37 + 5) & 0xff)), ...R(0x208000, 32), // Op01 bitplanes
      ...W(0x208000, 0x03, 0x05),                                                          // Op03 transparent colour
      ...W(0x208000, 0x05, 0x04, 0x12, 0x50, 0x34, 0x05, 0x56, 0x60, 0x78, 0x05), ...R(0x208000, 4), // Op05 overlay
      ...W(0x208000, 0x06, 0x04, 0x12, 0x34, 0x56, 0x78), ...R(0x208000, 4),              // Op06 reverse
      ...W(0x208000, 0x0d, 0x06, 0x04, 0x12, 0x34, 0x56), ...R(0x208000, 4),              // Op0D scale
      ...R(0x208000),
    ],
  },
  // DSP-3: M_DSP3_LOROM, data $20:8000, status $20:C000 (header $FFDA = $B2)
  "DSP-3": {
    image: { mapMode: 0x30, romType: 0x05, header: { 0x2a: 0xb2 } },
    ops: [
      ...R(0x20c000),
      ...W(0x208000, 0x06), ["w16", 0x208000, 0x1020], ...R(0x20c000),                   // Op06 window
      ...W(0x208000, 0x03), ["w16", 0x208000, 0x0507], ["r16", 0x208000], ...R(0x20c000), // Op03 offset
      ...W(0x208000, 0x0f), ["w16", 0x208000, 0x0000], ["r16", 0x208000],                 // Op0F test memory
      ...W(0x208000, 0x07), ["w16", 0x208000, 0x0003], ["w16", 0x208000, 0x0102], ["r16", 0x208000], ["r16", 0x208000], // Op07
      ...W(0x208000, 0x1f), ["r16", 0x208000], ["r16", 0x208000], ["r16", 0x208000], ["r16", 0x208000],    // Op1F data ROM
      ...W(0x208000, 0x0c), ["w16", 0x208000, 0x0203], ["w16", 0x208000, 0x0104], ["r16", 0x208000], ["r16", 0x208000], // Op0C
    ],
  },
  // DSP-4: M_DSP4_LOROM, data $30:8000, status $30:C000
  "DSP-4": {
    image: { mapMode: 0x30, romType: 0x03 },
    ops: [
      ...R(0x30c000),
      ...W(0x308000, 0x00, 0x00, 0x34, 0x12, 0x78, 0x56), ...R(0x308000, 4),             // command $0000: multiply
      ...W(0x308000, 0x11, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00), ...R(0x308000, 2), // $0011
      ...W(0x308000, 0x0e, 0x00), ...R(0x308000, 4),                                       // $000E
      ...W(0x308000, 0x0a, 0x00, 0x10, 0x00, 0x20, 0x00, 0x30, 0x00), ...R(0x308000, 8), ...R(0x30c000),
    ],
  },
  // ST010: Map_SetaDSPLoROMMap; $60:0000 enables control, $68:0000+ is the chip's RAM (SRAM)
  "ST010": {
    image: { mapMode: 0x30, romType: 0xf6, romSize: 0x0a, banks: 32 },
    ops: [
      ...R(0x600000), ["w", 0x600000, 0x01],
      ...W(0x680000, 0x34), ["w", 0x680001, 0x12], ["w", 0x680002, 0x78], ["w", 0x680003, 0x56],
      ["w", 0x680020, 0x06], ["w", 0x680021, 0x80], ...R(0x680021), ...Rs(0x680010, 4),     // op 6: 16-bit multiply
      ["w", 0x680000, 0x40], ["w", 0x680001, 0x00], ["w", 0x680002, 0x30], ["w", 0x680003, 0x00],
      ["w", 0x680020, 0x04], ["w", 0x680021, 0x80], ...Rs(0x680010, 2),                        // op 4: vector length
      ["w", 0x680000, 0x10], ["w", 0x680001, 0x00], ["w", 0x680002, 0x20], ["w", 0x680003, 0x00],
      ["w", 0x680020, 0x01], ["w", 0x680021, 0x80], ...Rs(0x680000, 8), ...Rs(0x680010, 2),   // op 1: heading
      ["w", 0x680000, 0x00], ["w", 0x680001, 0x10], ["w", 0x680002, 0x00], ["w", 0x680003, 0x08], ["w", 0x680004, 0x00], ["w", 0x680005, 0x20],
      ["w", 0x680020, 0x08], ["w", 0x680021, 0x80], ...Rs(0x680010, 4), ...Rs(0x680020, 2),   // op 8: rotation
    ],
  },
  // ST011: ROM size byte $09 picks it; the chip talks through SRAM at $68:0000
  "ST011": {
    image: { mapMode: 0x30, romType: 0xf6, romSize: 0x09 },
    ops: [
      ...R(0x680001), ...R(0x680000),
      ["w", 0x680000, 0x02], ["w", 0x680000, 0x11], ["w", 0x680000, 0x22], ["w", 0x680000, 0x33], ["w", 0x680000, 0x44],
      ...R(0x680000),
      ["w", 0x68012c, 0x77], ["w", 0x68012d, 0x77], ["w", 0x68012e, 0x77],
      ["w", 0x680000, 0x04], ...Rs(0x68012c, 3),
      ["w", 0x68012c, 0x66], ["w", 0x68012d, 0x66], ["w", 0x680000, 0x0e], ...Rs(0x68012c, 3),
    ],
  },
  // ST018: map_SetaRISC, $3000-$3FFF (snes9x's command stub)
  "ST018": {
    image: { mapMode: 0x30, romType: 0xf5, sram: 1 },
    ops: [
      ...R(0x003800), ...R(0x003804),
      ["w", 0x003804, 0x00], ["w", 0x003804, 0x01], ["w", 0x003804, 0x00],
      ...R(0x003804, 3), ...R(0x003800),
      ["w", 0x003802, 0x42], ...R(0x003804, 4),
      ["w", 0x003802, 0x43], ...R(0x003804, 4),
      ...R(0x700000), ...R(0x703802),
    ],
  },
  // OBC1: LoROM, $00-$3F:6000-7FFF
  "OBC1": {
    image: { mapMode: 0x30, romType: 0x25, sram: 1 },
    ops: [
      ...R(0x006000), ...Rs(0x007ff0, 5),
      ["w", 0x007ff5, 0x00], ["w", 0x007ff6, 0x05],
      ["w", 0x007ff0, 0x11], ["w", 0x007ff1, 0x22], ["w", 0x007ff2, 0x33], ["w", 0x007ff3, 0x44], ["w", 0x007ff4, 0x02],
      ...Rs(0x007ff0, 5), ...Rs(0x007c14, 4), ...R(0x007e01),
      ["w", 0x007ff5, 0x01], ["w", 0x007ff6, 0x40], ["w", 0x007ff0, 0x99], ["w", 0x007ff4, 0x03],
      ...R(0x007ff0), ...R(0x007ff4), ...R(0x007900), ...R(0x007a10),
      ["w", 0x806123, 0x5a], ...R(0x006123), ["r16", 0x007ff0],
    ],
  },
  // S-RTC: identifier $5535, $2800 read / $2801 write, the clock on the host's frame clock
  "S-RTC": {
    image: { hirom: true, banks: 32, mapMode: 0x35, romType: 0x55 },
    ops: [
      ...R(0x002800, 15),
      ...W(0x002801, 0x0e, 0x04, 0x0e, 0x00, 5, 4, 9, 5, 3, 2, 8, 2, 12, 9, 9, 9, 0x0d),
      ...R(0x002800, 15),
      ["frames", 90],
      ...R(0x002800, 15),
      ...W(0x002801, 0x0d), ...R(0x002800, 3), ...R(0x802800),
    ],
    frames: 100,
  },
};

/**
 * An MSU-1 test cart and pack: the ID and status registers, a data seek
 * read by the CPU and then by DMA from $00:2001, a missing track (the error
 * bit), track 1 played with repeat, a per-frame volume ramp from NMI and
 * track 2 (no repeat) started at frame 200. Writes <dir>/<stem>.sfc, .msu,
 * -1.pcm and -2.pcm; returns the ROM path.
 * @param {(path: string, bytes: Uint8Array) => void} write
 * @param {string} stem  path without extension
 */
export function writeMsuTestPack(write, stem) {
  let k = 0;
  const long = (a) => [a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff];
  const rd = (a) => [0xaf, ...long(a), 0x8f, ...long(0x7e0100 + k++)];
  const st = (a, v) => [0xa9, v, 0x8f, ...long(a)];
  const code = [
    0x78, 0x18, 0xfb, 0xe2, 0x30,
    ...rd(0x2000), ...rd(0x2002), ...rd(0x2003), ...rd(0x2004), ...rd(0x2005), ...rd(0x2006), ...rd(0x2007),
    ...st(0x2000, 0x23), ...st(0x2001, 0x01), ...st(0x2002, 0x00), ...st(0x2003, 0x00),
    ...rd(0x2001), ...rd(0x2001), ...rd(0x2001), ...rd(0x2001),
    // 64 bytes by DMA from $00:2001 (fixed A address) to $7E0200 through $2180
    ...st(0x2181, 0x00), ...st(0x2182, 0x02), ...st(0x2183, 0x00),
    ...st(0x4300, 0x08), ...st(0x4301, 0x80), ...st(0x4302, 0x01), ...st(0x4303, 0x20), ...st(0x4304, 0x00),
    ...st(0x4305, 0x40), ...st(0x4306, 0x00), ...st(0x420b, 0x01),
    ...st(0x2004, 0x03), ...st(0x2005, 0x00), ...rd(0x2000),
    ...st(0x2006, 0xc0), ...st(0x2004, 0x01), ...st(0x2005, 0x00), ...rd(0x2000),
    ...st(0x2007, 0x03), ...rd(0x2000),
    ...st(0x4200, 0x80),
    0x80, 0xfe,
  ];
  // NMI at $8400: 16-bit frame count at $7E0010, volume = its low byte,
  // track 2 at count 200, the status every frame at $7E0012
  const nmi = [
    0xc2, 0x20, 0xaf, 0x10, 0x00, 0x7e, 0x1a, 0x8f, 0x10, 0x00, 0x7e, 0xe2, 0x20,
    0xaf, 0x10, 0x00, 0x7e, 0x8f, 0x06, 0x20, 0x00,
    0xc2, 0x20, 0xaf, 0x10, 0x00, 0x7e, 0xc9, 0xc8, 0x00, 0xe2, 0x20, 0xd0, 0x12,
    0xa9, 0x02, 0x8f, 0x04, 0x20, 0x00, 0xa9, 0x00, 0x8f, 0x05, 0x20, 0x00, 0xa9, 0x01, 0x8f, 0x07, 0x20, 0x00,
    0xaf, 0x00, 0x20, 0x00, 0x8f, 0x12, 0x00, 0x7e,
    0x40,
  ];
  const full = new Array(0x400).fill(0xea);
  full.splice(0, code.length, ...code);
  const img = chipImage({ code: [...full, ...nmi], mapMode: 0x20, romType: 0x00, title: "MSU1 SYNTH TEST      " });
  img[0x7fea] = 0x00; img[0x7feb] = 0x84;
  { const h = 0x7fb0; img[h + 0x2c] = img[h + 0x2d] = img[h + 0x2e] = img[h + 0x2f] = 0;
    let sum = 0; for (const b of img) sum = (sum + b) & 0xffff; sum = (sum + 0x1fe) & 0xffff;
    img[h + 0x2c] = (sum ^ 0xffff) & 0xff; img[h + 0x2d] = (sum ^ 0xffff) >> 8; img[h + 0x2e] = sum & 0xff; img[h + 0x2f] = sum >> 8; }
  const data = new Uint8Array(4096);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 8)) & 0xff;
  // "MSU1", u32 loop sample, s16 stereo at 44100 Hz
  const pcm = (seconds, f1, f2, loop) => {
    const ns = Math.floor(44100 * seconds);
    const b = new Uint8Array(8 + ns * 4);
    const dv = new DataView(b.buffer);
    b.set([0x4d, 0x53, 0x55, 0x31]); dv.setUint32(4, loop, true);
    for (let i = 0; i < ns; i++) {
      dv.setInt16(8 + i * 4, Math.round(9000 * Math.sin(2 * Math.PI * f1 * i / 44100)), true);
      dv.setInt16(10 + i * 4, Math.round(7000 * Math.sin(2 * Math.PI * f2 * i / 44100) + 3000 * ((i % 200) / 100 - 1)), true);
    }
    return b;
  };
  write(stem + ".sfc", img);
  write(stem + ".msu", data);
  write(stem + "-1.pcm", pcm(2.5, 440, 330, 22050));
  write(stem + "-2.pcm", pcm(1.3, 523, 659, 0));
  return stem + ".sfc";
}
