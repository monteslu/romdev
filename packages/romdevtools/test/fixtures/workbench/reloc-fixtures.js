// A translation unit that calls one placeholder and loads through another,
// the module image that carries the stored addends, and the module map that
// places it. Synthetic bytes only.
import { R_MIPS_26, R_MIPS_HI16, R_MIPS_LO16, STB_GLOBAL, STT_FUNC, buildRelocatable, words } from "./elf-fixtures.js";
import { MODULE_MAP_SCHEMA } from "../../../src/decomp/workbench/reloc-surface.js";

export const JAL = 0x0C000000, LUI = 0x3C010000, LW = 0x8C210000, NOP = 0;
export const MODULE_START = 0x1000, TU_OFFSET = 0x40;
export const sym = (name, value = 0, size = 0, kind = 0, binding = STB_GLOBAL, section = null) => ({ name, value, size, kind, binding, section });
export const rel = (section, offset, symbol, type) => ({ section, offset, symbol, type });
const hx = (n) => `0x${n.toString(16)}`;

export function candidateObject({ low_addend = 0x10, jal_symbol = "callee" } = {}) {
  return buildRelocatable({ ".text": words(JAL, NOP, LUI, (LW | low_addend) >>> 0) },
    [sym("myFunc", 0, 16, STT_FUNC, STB_GLOBAL, ".text"), sym(jal_symbol), sym("gBase")],
    [rel(".text", 0, jal_symbol, R_MIPS_26), rel(".text", 8, "gBase", R_MIPS_HI16), rel(".text", 12, "gBase", R_MIPS_LO16)]);
}

export function shippedImage({ jal_immediate = 0x123, lo = 0x8020 } = {}) {
  const image = Buffer.alloc(0x4000);
  words((JAL | jal_immediate) >>> 0, NOP, (LUI | 0x0002) >>> 0, (LW | lo) >>> 0).copy(image, MODULE_START + TU_OFFSET);
  return image;
}

export function moduleDocument(overrides = {}) {
  return { schema: MODULE_MAP_SCHEMA, module: {
    name: "m1", image_start: "0x1000", image_end: "0x2000", synthetic_vma: "0xF0000000",
    sections: { ".text": { offset: 0, size: 0x800 } },
    text_placement: [{ object: "tu.c.o", section: ".text", offset: hx(TU_OFFSET), size: 16 }],
    relocation_sites: [{ offset: TU_OFFSET, type: "R_MIPS_26" }, { offset: TU_OFFSET + 8, type: "R_MIPS_HI16" }, { offset: TU_OFFSET + 12, type: "R_MIPS_LO16" }],
    ...overrides } };
}
