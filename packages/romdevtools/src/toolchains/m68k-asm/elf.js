// Minimal ELF32 symbol-table reader for the m68k-asm front end: after a link,
// the final address of every label (local ones included) is read back from the
// linked ELF, so a second translation pass can lay code out with the real
// addresses in hand.
//
// Plain JS ESM + JSDoc.

/**
 * Read defined symbols from an ELF32 image (either byte order).
 * @param {Uint8Array} elf
 * @returns {Map<string, number>} name → value (st_value, the linked address)
 */
export function readElfSymbols(elf) {
  const out = new Map();
  if (!elf || elf.length < 52 || elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46) return out;
  if (elf[4] !== 1) return out; // ELFCLASS32 only
  const le = elf[5] === 1;
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  const shoff = u32(0x20);
  const shentsize = u16(0x2e);
  const shnum = u16(0x30);
  if (!shoff || !shnum) return out;
  const sh = (i) => {
    const o = shoff + i * shentsize;
    return { type: u32(o + 4), offset: u32(o + 16), size: u32(o + 20), link: u32(o + 24), entsize: u32(o + 36) };
  };
  for (let i = 0; i < shnum; i++) {
    const s = sh(i);
    if (s.type !== 2) continue; // SHT_SYMTAB
    const str = sh(s.link);
    const n = Math.floor(s.size / (s.entsize || 16));
    for (let k = 1; k < n; k++) {
      const o = s.offset + k * (s.entsize || 16);
      const nameOff = u32(o);
      const value = u32(o + 4);
      const shndx = u16(o + 14);
      if (shndx === 0) continue; // undefined
      let e = str.offset + nameOff;
      let name = "";
      while (e < elf.length && elf[e] !== 0) name += String.fromCharCode(elf[e++]);
      if (name && !out.has(name)) out.set(name, value);
    }
  }
  return out;
}
