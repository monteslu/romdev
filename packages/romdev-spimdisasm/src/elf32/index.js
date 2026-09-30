// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/__init__.py

import * as Elf32Constants from "./Elf32Constants.js";

// Python exposes the submodule too (`from spimdisasm.elf32 import Elf32Constants`).
export { Elf32Constants };

export {
  Elf32HeaderIdentifier,
  Elf32ObjectFileType,
  Elf32HeaderFlag,
  Elf32SectionHeaderType,
  Elf32SectionHeaderFlag,
  Elf32SymbolTableType,
  Elf32SymbolTableBinding,
  Elf32SymbolVisibility,
  Elf32SectionHeaderNumber,
  Elf32DynamicTable,
} from "./Elf32Constants.js";
export { Elf32Dyns, Elf32DynEntry } from "./Elf32Dyns.js";
export { Elf32GlobalOffsetTable } from "./Elf32GlobalOffsetTable.js";
export { Elf32Header } from "./Elf32Header.js";
export { Elf32RegInfo } from "./Elf32RegInfo.js";
export { Elf32SectionHeaders, Elf32SectionHeaderEntry } from "./Elf32SectionHeaders.js";
export { Elf32StringTable } from "./Elf32StringTable.js";
export { Elf32Syms, Elf32SymEntry } from "./Elf32Syms.js";
export { Elf32Rels, Elf32RelEntry } from "./Elf32Rels.js";

export { Elf32File } from "./Elf32File.js";

// To avoid breaking backwards compatibility
export { RelocType as Elf32Relocs } from "../common/Relocation.js";
