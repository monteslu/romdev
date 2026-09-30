// local-pc16.js - authenticate local REL PC16 branch destinations from the
// ELF without changing comparison bytes. Anything unknown, external,
// linking, malformed or inconsistent keeps its original view.
//
// Plain JS ESM + JSDoc.

import { ElfFormatError, readElf } from "./elf.js";
import { replace, floorDiv } from "./py.js";

function nonlinkingBranch(word) {
  const opcode = word >>> 26, rt = (word >>> 16) & 31;
  if ([4, 5, 20, 21].includes(opcode)) return true;
  if ([6, 7, 22, 23].includes(opcode)) return rt === 0;
  if (opcode === 1) return [0, 1, 2, 3].includes(rt);
  return opcode === 17 && ((word >>> 21) & 31) === 8 && [0, 1, 2, 3].includes(rt);
}

/** Add alignment hints only for ELF-proved branches inside the owned function. */
export function annotateLocalPc16(p, instructions, extent) {
  if (extent === null || extent === undefined || extent.stop === null) return instructions;
  if (!instructions.some((i) => i.relocations.some((r) => r.kind === "R_MIPS_PC16"))) return instructions;
  let elf;
  try { elf = readElf(p); } catch (e) { if (e instanceof ElfFormatError || (e && e.code)) return instructions; throw e; }
  const id = elf.data.subarray(16, 20);
  if (!(id[0] === 0 && id[1] === 1 && id[2] === 0 && id[3] === 8) || elf.malformed_reloc_sections.length) return instructions;
  const section = elf.section(extent.section);
  const body = elf.sectionBytes(extent.section);
  if (section === null || body === null || !(section.flags & 4) || section.addr !== 0
    || !(0 <= extent.start && extent.start < extent.stop && extent.stop <= body.length) || extent.start % 4 || extent.stop % 4) return instructions;
  const owners = elf.symbols.filter((s) => s.name === extent.name);
  if (owners.length !== 1 || owners[0].shndx !== section.index) return instructions;
  if (owners[0].value !== extent.start) return instructions;
  if (owners[0].size && owners[0].value + owners[0].size !== extent.stop) return instructions;
  const byOffset = new Map();
  for (const r of elf.relocationsFor(extent.section)) { if (!byOffset.has(r.offset)) byOffset.set(r.offset, []); byOffset.get(r.offset).push(r); }
  const addresses = new Set(instructions.map((i) => i.address));
  return instructions.map((ins) => {
    const offset = ins.address;
    const raw = byOffset.get(offset) ?? [];
    let destination = null;
    if (extent.contains(offset) && offset % 4 === 0 && raw.length === 1 && raw[0].type === 10 && ins.relocations.length === 1
      && ins.relocations[0].kind === "R_MIPS_PC16" && ins.relocations[0].offset === offset
      && offset + 4 <= body.length && ins.word_value === body.readUInt32BE(offset) && nonlinkingBranch(ins.word_value)) {
      const symbol = elf.symbol(raw[0].sym_index);
      if (symbol !== null && symbol.shndx === section.index && symbol.name === ins.relocations[0].symbol && extent.contains(symbol.value) && symbol.value % 4 === 0) {
        let addend = ins.word_value & 0xFFFF;
        if (addend & 0x8000) addend -= 0x10000;
        const resolved = symbol.value + addend * 4 + 4;
        const displacement = resolved - offset - 4;
        if (extent.contains(resolved) && addresses.has(resolved) && displacement % 4 === 0 && -0x8000 <= floorDiv(displacement, 4) && floorDiv(displacement, 4) <= 0x7FFF) destination = resolved;
      }
    }
    return replace(ins, { local_branch_destination: destination });
  });
}
