// Registers the segment types by platform, mirroring splat's module lookup
// (segtypes.<platform>.<type>, then segtypes.common.<type>).
import { registry } from './registry.js';
import { LinkerEntry } from './linker_entry.js';
import * as C from './common.js';
import * as N from './platform.js';
import { loadExtension } from '../ext/index.js';

registry.LinkerEntry = LinkerEntry;
registry.loadExtension = loadExtension;

Object.assign(registry.common, {
  asm: C.CommonSegAsm,
  asmtu: C.CommonSegAsmtu,
  bin: C.CommonSegBin,
  bss: C.CommonSegBss,
  c: C.CommonSegC,
  code: C.CommonSegCode,
  cpp: C.CommonSegCpp,
  data: C.CommonSegData,
  databin: C.CommonSegDatabin,
  group: C.CommonSegGroup,
  hasm: C.CommonSegHasm,
  header: C.CommonSegHeader,
  lib: C.CommonSegLib,
  linker_offset: C.CommonSegLinker_offset,
  pad: C.CommonSegPad,
  rdata: C.CommonSegRdata,
  rodata: C.CommonSegRodata,
  rodatabin: C.CommonSegRodatabin,
  sbss: C.CommonSegSbss,
  sdata: C.CommonSegSdata,
  textbin: C.CommonSegTextbin,
});

Object.assign(registry.platform.n64, {
  ci: N.N64SegCi,
  ci4: N.N64SegCi4,
  ci8: N.N64SegCi8,
  header: N.N64SegHeader,
  i1: N.N64SegI1,
  i4: N.N64SegI4,
  i8: N.N64SegI8,
  ia16: N.N64SegIa16,
  ia4: N.N64SegIa4,
  ia8: N.N64SegIa8,
  img: N.N64SegImg,
  ipl3: N.N64SegIpl3,
  palette: N.N64SegPalette,
  rgba16: N.N64SegRgba16,
  rgba32: N.N64SegRgba32,
  rsp: N.N64SegRsp,
  vtx: N.N64SegVtx,
});

Object.assign(registry.platform.psx, {
  header: N.PsxSegHeader,
});

// splat segment types this port does not implement (no romdev target uses
// them): resolve them so the lookup order stays the same as splat's, then refuse.
function notPorted(name) {
  return class {
    constructor() { throw new Error(`romdev-splat: segment type '${name}' is not ported`); }
    static is_noload() { return false; }
    static estimate_size() { return null; }
  };
}
for (const t of ['eh_frame', 'gcc_except_table']) registry.common[t] = notPorted(t);
for (const t of ['gfx', 'mio0', 'yay0', 'decompressor']) registry.platform.n64[t] = notPorted(t);
for (const t of ['ctor', 'lit4', 'lit8', 'vtables']) registry.platform.ps2[t] = notPorted(t);
