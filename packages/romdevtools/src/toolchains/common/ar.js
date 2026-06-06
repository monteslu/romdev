// ar.js — pure-JS writer for the GNU `ar` static-library format, WITH the
// ranlib symbol index. We compile SDK libraries (libtonc/libgba/maxmod/...)
// FROM SOURCE into loose .o objects, then pack them into a real .a so the
// linker pulls only referenced members — exactly like a prebuilt .a, and
// without "multiple definition" collisions from mutually-exclusive members.
//
// GNU ld requires the archive symbol index ("archive has no index; run
// ranlib"), so we parse each ELF object's symbol table and emit the leading
// "/" index member ourselves. No binutils `ar`/`ranlib` wasm needed.
//
// Archive layout:
//   "!<arch>\n"
//   "/"  member  → symbol index: u32be count, count×u32be member-header
//                  offsets, then NUL-terminated symbol names
//   per object member: 60-byte ASCII header + data (padded to even length)

const MAGIC = "!<arch>\n";
const HEADER_SIZE = 60;

function arHeader(name, size) {
  const f = (s, w) => { s = String(s); if (s.length > w) throw new Error(`ar field "${s}" > ${w}`); return s + " ".repeat(w - s.length); };
  return Buffer.from(
    f(name, 16) + f("0", 12) + f("0", 6) + f("0", 6) + f("644", 8) + f(size, 10) + "`\n",
    "ascii",
  );
}

// ── Minimal ELF32 little-endian symbol extractor ─────────────────────────
// Returns the names of GLOBAL/WEAK symbols that this object DEFINES (st_shndx
// != SHN_UNDEF). These are what the linker indexes to decide which members to
// pull. (32-bit LE only — our ARM and m68k targets are both ELF32; m68k is
// big-endian data, handled via the byteorder flag.)
function definedGlobals(obj) {
  const le = obj[5] === 1; // EI_DATA: 1 = LE, 2 = BE
  const dv = new DataView(obj.buffer, obj.byteOffset, obj.byteLength);
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  if (obj[0] !== 0x7f || obj[1] !== 0x45) return []; // not ELF
  const e_shoff = u32(0x20), e_shentsize = u16(0x2e), e_shnum = u16(0x30);

  // Find .symtab (type 2) and its linked .strtab.
  let symOff = 0, symSize = 0, symEnt = 0, strSecIdx = 0;
  for (let i = 0; i < e_shnum; i++) {
    const sh = e_shoff + i * e_shentsize;
    if (u32(sh + 4) === 2 /* SHT_SYMTAB */) {
      symOff = u32(sh + 16); symSize = u32(sh + 20);
      strSecIdx = u32(sh + 24); symEnt = u32(sh + 36) || 16;
      break;
    }
  }
  if (!symOff) return [];
  const strSh = e_shoff + strSecIdx * e_shentsize;
  const strOff = u32(strSh + 16);

  const names = [];
  const count = Math.floor(symSize / symEnt);
  for (let i = 0; i < count; i++) {
    const s = symOff + i * symEnt;
    const st_name = u32(s + 0);
    const st_info = obj[s + 12];
    const st_shndx = u16(s + 14);
    const bind = st_info >> 4;           // 1=GLOBAL, 2=WEAK
    if ((bind === 1 || bind === 2) && st_shndx !== 0 /* SHN_UNDEF */ && st_name !== 0) {
      // read NUL-terminated name from strtab
      let p = strOff + st_name, end = p;
      while (obj[end] !== 0) end++;
      names.push(Buffer.from(obj.buffer, obj.byteOffset + p, end - p).toString("ascii"));
    }
  }
  return names;
}

/**
 * Pack named objects into a GNU ar archive WITH a symbol index.
 * @param {Record<string, Uint8Array>} members  objName → object bytes
 * @returns {Uint8Array}
 */
export function packAr(members) {
  const entries = Object.entries(members).map(([rawName, bytes]) => {
    const name = (rawName.endsWith("/") ? rawName : rawName + "/");
    if (name.length > 16) throw new Error(`ar member name too long: "${rawName}"`);
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { name, data, syms: definedGlobals(bytes) };
  });

  // Build the symbol index payload to learn its size (offsets depend on it).
  const symList = [];
  for (let i = 0; i < entries.length; i++) {
    for (const s of entries[i].syms) symList.push({ sym: s, member: i });
  }
  const nameBlob = Buffer.from(symList.map((e) => e.sym).join("\0") + (symList.length ? "\0" : ""), "ascii");
  let indexBody = 4 + symList.length * 4 + nameBlob.length;
  if (indexBody % 2 === 1) indexBody++; // padded to even
  const indexMemberTotal = HEADER_SIZE + indexBody;

  // Compute each member's header offset (after magic + index member).
  let pos = MAGIC.length + indexMemberTotal;
  const memberOffset = [];
  for (const e of entries) {
    memberOffset.push(pos);
    let dataLen = e.data.length;
    if (dataLen % 2 === 1) dataLen++;
    pos += HEADER_SIZE + dataLen;
  }

  // Serialize the index body: u32be count, u32be offsets, name blob, pad.
  const idx = Buffer.alloc(indexBody);
  idx.writeUInt32BE(symList.length, 0);
  for (let i = 0; i < symList.length; i++) {
    idx.writeUInt32BE(memberOffset[symList[i].member], 4 + i * 4);
  }
  nameBlob.copy(idx, 4 + symList.length * 4);

  // Assemble.
  const chunks = [Buffer.from(MAGIC, "ascii"), arHeader("/", indexBody), idx];
  for (const e of entries) {
    chunks.push(arHeader(e.name, e.data.length), e.data);
    if (e.data.length % 2 === 1) chunks.push(Buffer.from("\n", "ascii"));
  }
  return new Uint8Array(Buffer.concat(chunks));
}
