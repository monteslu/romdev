// Handcrafted linker-map excerpts and word images for the shift family's
// tests (no bytes from any ROM). Port of the workbench test fixtures.
import { parseLdMap } from "../../../src/decomp/workbench/ldmap.js";
import { PinCatalogue, defaultPinModel, parsePinText } from "../../../src/decomp/workbench/pins.js";
import { buildShiftAudit } from "../../../src/decomp/workbench/shift-audit.js";

export const words = (list) => Buffer.concat(list.map((w) => { const b = Buffer.alloc(4); b.writeUInt32BE(w >>> 0); return b; }));
export const zeros = (n) => Array(n).fill(0);

export const SYNTHETIC_MAP = `
Linker script and memory map

.header         0x00000000       0x10
 .data          0x00000000       0x10 build/header.o

.boot           0x00000010       0x10
 .data          0x00000010       0x10 build/boot.o

.main           0x80000400       0x80 load address 0x00000020
 .text          0x80000400       0x20 build/code.o
 .text          0x80000420       0x10 build/more.o
 .data          0x80000430       0x30 build/code.o
                0x80000430                gData
                0x80000440                gTarget
                0x80000450                gOther
 .rodata        0x80000460       0x20 build/code.o

.main_bss       0x80000480    0x10020 load address 0x000000a0
 .bss           0x80000480    0x10020 build/code.o
                0x800104a0                main_BSS_END
`;

export const SYNTHETIC_WORDS = [
  0, 0x80000444, 0, 0,
  0x80000440, 0x80000444, 0, 0,
  0x80000440, ...zeros(11),
  0x80000440, 0x80000443, 0x80010000, 0x80000454, 0x80000460, 0x80000464, 0x80000468, 0,
  0x80000474, 0x80000474, 0x80000474, 0x80000474, 0x80000480, ...zeros(7),
];
export const SYNTHETIC_IMAGE = words(SYNTHETIC_WORDS);

export const NON_ALLOC_MAP = `
Linker script and memory map

.main           0x80000400       0x40 load address 0x00000100
 .text          0x80000400       0x40 build/code.o

.main_bss       0x80000440       0x40 load address 0x00000140
 .bss           0x80000440       0x40 build/code.o

.mdebug         0x00000000       0x20
 .mdebug        0x00000000       0x10 build/code.o
 .mdebug        0x00000010       0x10 build/other.o

.mdebug.abi32   0x00000020        0x8
 .mdebug.abi32  0x00000020        0x8 build/code.o

.pdr            0x00000028       0x10
 .pdr           0x00000028       0x10 build/code.o

.comment        0x00000038        0x8
 .comment       0x00000038        0x8 build/code.o

.gptab.sdata    0x00000040        0x8
 .gptab.sdata   0x00000040        0x8 build/code.o

.reginfo        0x00000048       0x18
 .reginfo       0x00000048       0x18 build/code.o

.options        0x00000060        0x8
 .options       0x00000060        0x8 build/code.o

.debug_info     0x00000068       0x10
 .debug_info    0x00000068       0x10 build/code.o

.line           0x00000078        0x8
 .line          0x00000078        0x8 build/code.o

.rel.text       0x00000080        0x8
 .rel.text      0x00000080        0x8 build/code.o
`;

export const NON_ALLOC_WITH_AT_MAP = `
Linker script and memory map

.main           0x80000400       0x10 load address 0x00000100

.comment        0x00000000       0x10 load address 0x00000200
 .comment       0x00000000       0x10 build/code.o
`;

export const OVERLAY_SIBLING_MAP = `
Linker script and memory map

.overlay_a      0x80386000       0x20 load address 0x00100000
 .text          0x80386000       0x10 build/a.o
 .data          0x80386010       0x10 build/a.o

.overlay_b      0x80386000       0x10 load address 0x00200000
 .text          0x80386000       0x10 build/b.o
`;

export const BLOB_INPUT_MAP = `
Linker script and memory map

.header         0x00000000       0x10
 .data          0x00000000       0x10 build/header.o

.boot           0x00000010       0x10
 .data          0x00000010       0x10 build/assets/boot.bin.o

.assets         0x00000020       0x10 load address 0x00000020
 .data          0x00000020       0x10 build/assets/assets.bin.o

.filesys        0x00000030       0x10 load address 0x00000030
 .data          0x00000030       0x10 build/bin/filesys.o

.main           0x80000400       0x40 load address 0x00000040
 .text          0x80000400       0x20 build/code.o
 .data          0x80000420       0x10 build/bin/data_1000.bin.o
 .data          0x80000430       0x10 build/code.o

.main_bss       0x80000440       0x20 load address 0x00000080
 .bss           0x80000440       0x20 build/code.o
`;

export const BLOB_INPUT_WORDS = [0x20, ...zeros(3), ...zeros(4), ...zeros(4), 0x80000424, ...zeros(3), ...zeros(8), 0x80000420, ...zeros(7)];
export const BLOB_INPUT_IMAGE = words(BLOB_INPUT_WORDS);

export const blobInputMap = () => parseLdMap(BLOB_INPUT_MAP, { path: "blobs.map" });
export const syntheticMap = () => parseLdMap(SYNTHETIC_MAP, { path: "synthetic.map" });
export const emptyPins = () => new PinCatalogue({ entries: [], sources: [] });
export const readPinText = (text) => new PinCatalogue({ entries: parsePinText(text, { path: "pins.txt", model: defaultPinModel() }), sources: ["pins.txt"] });

export function blobAudit(extra = {}) {
  return buildShiftAudit({ ldmap: blobInputMap(), image: BLOB_INPUT_IMAGE, pins: emptyPins(), model: defaultPinModel(), map_path: "blobs.map", image_path: "blobs.z64", ...extra });
}

export function audit({ blobs = [".boot"], whitelist = [] } = {}) {
  return buildShiftAudit({ ldmap: syntheticMap(), image: SYNTHETIC_IMAGE, pins: emptyPins(), model: defaultPinModel({ whitelist }), blobs,
    map_path: "synthetic.map", image_path: "synthetic.z64" });
}

export const tiers = (found) => ({ high: found.scan_high, medium: found.scan_medium, low: found.scan_low });
export const hitAt = (found, rom) => found.hits.find((h) => h.rom === rom);
