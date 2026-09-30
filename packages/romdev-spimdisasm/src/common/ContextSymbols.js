// SPDX-License-Identifier: MIT
// Port of spimdisasm/common/ContextSymbols.py

import { rabbitizer } from "../rabbitizer.js";
import { GlobalConfig } from "./GlobalConfig.js";
import { FileSectionType } from "./FileSectionType.js";
import { SortedDict } from "./SortedDict.js";
import * as Utils from "./Utils.js";
import { createEnum, hexU, pyStr, anyPySpace, enumValue } from "../py/pyutils.js";
import { atLeast, onVersionChange } from "../version.js";
import { newSymbolSet } from "./symset.js";

export const SymbolSpecialType = createEnum(
  "SymbolSpecialType",
  [
    ["function", 1],
    ["branchlabel", 2],
    ["jumptable", 3],
    ["jumptablelabel", 4],
    ["hardwarereg", 5],
    ["constant", 6],
    ["gccexcepttable", 7],
    ["gccexcepttablelabel", 8],
  ],
  {
    isTargetLabel() {
      return this === SymbolSpecialType.branchlabel || this === SymbolSpecialType.jumptablelabel || this === SymbolSpecialType.gccexcepttablelabel;
    },
    toStr() {
      return "@" + this.name;
    },
  },
  {
    fromStr(symTypeStr) {
      switch (symTypeStr) {
        case "@function": return SymbolSpecialType.function;
        case "@branchlabel": return SymbolSpecialType.branchlabel;
        case "@jumptable": return SymbolSpecialType.jumptable;
        case "@jumptablelabel": return SymbolSpecialType.jumptablelabel;
        case "@hardwarereg": return SymbolSpecialType.hardwarereg;
        case "@constant": return SymbolSpecialType.constant;
        case "@gccexcepttable": return SymbolSpecialType.gccexcepttable;
        case "@gccexcepttablelabel": return SymbolSpecialType.gccexcepttablelabel;
        default: return null;
      }
    },
  },
);

export function isSymbolSpecialType(x) {
  return x !== null && typeof x === "object" && x.__enumName === "SymbolSpecialType";
}

export class AccessTypeInfo {
  constructor(size, typeSigned, typeUnsigned, typeNameAliases = new Set()) {
    this.size = size;
    this.typeSigned = typeSigned;
    this.typeUnsigned = typeUnsigned;
    this.typeNameAliases = typeNameAliases;
  }

  typeMatchesAccess(typename) {
    if (typename === null || typename === undefined) return false;
    if (typename === this.typeSigned) return true;
    if (typename === this.typeUnsigned) return true;
    return typeof typename === "string" && this.typeNameAliases.has(typename);
  }

  getAllTypes() {
    const types = new Set();
    if (this.typeSigned !== null) types.add(this.typeSigned);
    if (this.typeUnsigned !== null) types.add(this.typeUnsigned);
    for (const t of this.typeNameAliases) types.add(t);
    return types;
  }
}

// Ordered like the Python dict literal.
const ACCESS_KIND_TABLE = [
  ["BYTE", new AccessTypeInfo(1, "s8", "u8", new Set(["vs8", "vu8"]))],
  ["SHORT", new AccessTypeInfo(2, "s16", "u16", new Set(["vs16", "vu16"]))],
  // Ignore signed WORD since it tends to not give a proper type
  ["WORD", new AccessTypeInfo(4, null, "u32", new Set(["s32", "vs32", "vu32"]))],
  ["DOUBLEWORD", new AccessTypeInfo(8, "s64", "u64", new Set(["vs64", "vu64"]))],
  ["QUADWORD", new AccessTypeInfo(16, null, null)],
  ["FLOAT", new AccessTypeInfo(4, "f32", null, new Set(["Vec3f"]))],
  ["DOUBLEFLOAT", new AccessTypeInfo(8, "f64", null)],
  ["WORD_LEFT", new AccessTypeInfo(null, null, null)],
  ["WORD_RIGHT", new AccessTypeInfo(null, null, null)],
  ["DOUBLEWORD_LEFT", new AccessTypeInfo(null, null, null)],
  ["DOUBLEWORD_RIGHT", new AccessTypeInfo(null, null, null)],
];

const ACCESS_KIND_BY_NAME = new Map(ACCESS_KIND_TABLE);

let _gAccessKinds = null;
let _accessByValue = null;

/** dict[rabbitizer.AccessType, AccessTypeInfo], built lazily (needs rabbitizer). */
export function getAccessKinds() {
  if (_gAccessKinds === null) {
    _gAccessKinds = new Map();
    _accessByValue = new Map();
    for (const [name, info] of ACCESS_KIND_TABLE) {
      const e = rabbitizer.AccessType[name];
      _gAccessKinds.set(e, info);
      _accessByValue.set(enumValue(e), info);
    }
  }
  return _gAccessKinds;
}

onVersionChange(() => {
  _gAccessKinds = null;
  _accessByValue = null;
});

/** gAccessKinds[accessType] */
export function accessKindInfo(accessType) {
  getAccessKinds();
  const info = _accessByValue.get(enumValue(accessType));
  if (info === undefined) throw new Error(`KeyError: ${accessType}`);
  return info;
}

function accessKindByName(name) {
  return ACCESS_KIND_BY_NAME.get(name);
}

function isAccessType(accessType, name) {
  if (accessType === null || accessType === undefined) return false;
  return enumValue(accessType) === enumValue(rabbitizer.AccessType[name]);
}

export const gKnownTypes = new Set(["asciz", "char", "char*", "String", "Char"]);
for (const [, kind] of ACCESS_KIND_TABLE) for (const t of kind.getAllTypes()) gKnownTypes.add(t);

/** ContextSymbol.__eq__ : same address and vromAddress. */
export function symEq(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (!(a instanceof ContextSymbol) || !(b instanceof ContextSymbol)) return false;
  return a.address === b.address && (a.vromAddress ?? null) === (b.vromAddress ?? null);
}

export class ContextSymbol {
  constructor(address, segment = null) {
    this.address = address;
    this.segment = segment;
    this.name = null;
    this.nameEnd = null;
    this.userDeclaredSize = null;
    this.autodetectedSize = null;
    this.userDeclaredType = null;
    this.autodetectedType = null;

    this.accessType = null;
    this.unsignedAccessType = null;

    this.vromAddress = null;

    this.sectionType = FileSectionType.Unknown;

    this.isDefined = false;
    this.isUserDeclared = false;
    this.isAutogenerated = false;

    this.isMaybeString = false;
    this.failedStringDecoding = false;
    this._ranStringCheck = false;

    this.isMaybePascalString = false;
    this.failedPascalStringDecoding = false;
    this._ranPascalStringCheck = false;

    this.referenceCounter = 0;
    this.referenceFunctions = newSymbolSet();
    this.referenceSymbols = newSymbolSet();

    this.parentFunction = null;
    this.branchLabels = new SortedDict();
    this.jumpTables = new SortedDict();

    this.parentFileName = null;
    this.inFileOffset = null;

    this.overlayCategory = null;

    this.nameGetCallback = null;

    this.unknownSegment = false;

    this.isGot = false;
    this.isGotGlobal = false;
    this.isGotLocal = false;
    this.gotIndex = null;

    this.accessedAsGpRel = false;

    this._isStatic = false;

    this.isAutoCreatedPad = false;
    this.autoCreatedPadMainSymbol = null;

    this.firstLoAccess = null;

    this.isElfNotype = false;

    this.forceMigration = false;
    this.forceNotMigration = false;
    this.functionOwnerForMigration = null;

    this.allowedToReferenceAddends = false;
    this.notAllowedToReferenceAddends = false;

    this.allowedToReferenceConstants = false;
    this.notAllowedToReferenceConstants = false;

    this.allowedToReferenceSymbols = true;
    this.allowedToBeReferenced = true;

    this.isAutocreatedSymFromOtherSizedSym = false;

    this.isMips1Double = false;

    this.visibility = null;

    this.alignmentShift = null;

    this.useNonMatchingLabel = true;
  }

  get vram() {
    return this.address;
  }

  /** @deprecated */
  get size() {
    return this.userDeclaredSize;
  }
  set size(value) {
    this.userDeclaredSize = value;
  }

  /** @deprecated */
  get type() {
    return this.getTypeSpecial();
  }
  set type(value) {
    this.setTypeSpecial(value, this.isAutogenerated);
  }

  hasNoType() {
    const currentType = this.getTypeSpecial();
    return (currentType === null || currentType === "") && this.accessType === null;
  }

  hasOnlyAutodetectedType() {
    if (this.userDeclaredType !== null && this.userDeclaredType !== "") return false;
    return (this.autodetectedType !== null && this.autodetectedType !== "") || this.accessType !== null;
  }

  isTrustableFunction(rsp = false) {
    if (this.unknownSegment) return false;
    if (this.isGotLocal) return false;
    if (this.isAutocreatedSymFromOtherSizedSym) return true;

    const currentType = this.getTypeSpecial();

    if (GlobalConfig.TRUST_USER_FUNCTIONS && this.isUserDeclared) {
      if (currentType === SymbolSpecialType.branchlabel) return false;
      return true;
    }

    if (GlobalConfig.TRUST_JAL_FUNCTIONS && this.isAutogenerated && currentType === SymbolSpecialType.function) return true;

    if (rsp) return true;

    return false;
  }

  isByte() {
    if (!GlobalConfig.USE_DOT_BYTE) return false;
    const currentType = this.getTypeSpecial();
    if (accessKindByName("BYTE").typeMatchesAccess(currentType)) return true;
    if (currentType !== null) return false;
    return isAccessType(this.accessType, "BYTE");
  }

  isShort() {
    if (!GlobalConfig.USE_DOT_SHORT) return false;
    const currentType = this.getTypeSpecial();
    if (accessKindByName("SHORT").typeMatchesAccess(currentType)) return true;
    if (currentType !== null) return false;
    return isAccessType(this.accessType, "SHORT");
  }

  isString() {
    if (this.failedStringDecoding) return false;

    const currentType = this.getTypeSpecial();

    let stringGuesserLevel;
    if (this.sectionType === FileSectionType.Rodata) stringGuesserLevel = GlobalConfig.RODATA_STRING_GUESSER_LEVEL;
    else stringGuesserLevel = GlobalConfig.DATA_STRING_GUESSER_LEVEL;

    if (currentType === "char" || currentType === "char*" || currentType === "asciz") return true;
    if (!this.isMaybeString) return false;

    if (stringGuesserLevel < 1) return false;

    if (this.hasNoType()) return true;

    if (this.hasOnlyAutodetectedType()) {
      if (stringGuesserLevel >= 4) return true;
    }
    return false;
  }

  isPascalString() {
    if (this.failedPascalStringDecoding) return false;

    const currentType = this.getTypeSpecial();

    let stringGuesserLevel;
    if (this.sectionType === FileSectionType.Rodata) stringGuesserLevel = GlobalConfig.PASCAL_RODATA_STRING_GUESSER_LEVEL;
    else stringGuesserLevel = GlobalConfig.PASCAL_DATA_STRING_GUESSER_LEVEL;

    if (currentType === "String" || currentType === "Char") return true;
    if (!this.isMaybePascalString) return false;

    if (stringGuesserLevel < 1) return false;

    if (this.hasNoType()) return true;

    if (this.hasOnlyAutodetectedType()) {
      if (stringGuesserLevel >= 4) return true;
    }
    return false;
  }

  isFloat() {
    if (this.vram % 4 !== 0) return false;
    const currentType = this.getTypeSpecial();
    if (accessKindByName("FLOAT").typeMatchesAccess(currentType)) return true;
    if (currentType !== null) return false;
    return isAccessType(this.accessType, "FLOAT");
  }

  isDouble() {
    if (this.vram % 8 !== 0) return false;
    const currentType = this.getTypeSpecial();
    if (accessKindByName("DOUBLEFLOAT").typeMatchesAccess(currentType)) return true;
    if (currentType !== null) return false;
    return isAccessType(this.accessType, "DOUBLEFLOAT");
  }

  isJumpTable() {
    return this.getTypeSpecial() === SymbolSpecialType.jumptable;
  }

  isGccExceptTable() {
    return this.getTypeSpecial() === SymbolSpecialType.gccexcepttable;
  }

  isStatic() {
    const currentType = this.getTypeSpecial();
    if (currentType === SymbolSpecialType.jumptablelabel) return false;
    if (this._isStatic) return true;
    if (atLeast("1.42.0") && this.nameGetCallback !== null) return false;
    if (this.name === null) return false;
    return this.name.startsWith(".");
  }

  isLateRodata() {
    if (!GlobalConfig.COMPILER.value.hasLateRodata) return false;
    return this.isJumpTable() || this.isFloat() || this.isDouble();
  }

  notPointerByType() {
    if (this.isByte()) return true;
    if (this.isShort()) return true;
    if (this.isFloat()) return true;
    if (this.isDouble()) return true;
    if (this.isString()) return true;
    if (this.isPascalString()) return true;
    return false;
  }

  hasUserDeclaredSize() {
    return this.userDeclaredSize !== null;
  }

  _defaultName_suffix() {
    let suffix = "";
    if (this.overlayCategory !== null) {
      suffix = "_";
      if (this.vromAddress !== null) suffix += hexU(this.vromAddress, 6);
    }
    if (GlobalConfig.CUSTOM_SUFFIX) suffix += GlobalConfig.CUSTOM_SUFFIX;
    return suffix;
  }

  _defaultName_uniqueIdentifier(symType) {
    if (GlobalConfig.SEQUENTIAL_LABEL_NAMES && this.parentFunction !== null) {
      if (symType === SymbolSpecialType.branchlabel || symType === SymbolSpecialType.jumptablelabel) {
        const index = this.parentFunction.branchLabels.index(this.vram);
        if (index !== null) return `${this.parentFunction.getName()}_${index + 1}`;
      } else if (symType === SymbolSpecialType.jumptable) {
        const index = this.parentFunction.jumpTables.index(this.vram);
        if (index !== null) return `${this.parentFunction.getName()}_${index + 1}`;
      }
    }

    if (GlobalConfig.AUTOGENERATED_NAMES_BASED_ON_FILE_NAME) {
      if (this.parentFileName !== null && this.inFileOffset !== null && symType !== SymbolSpecialType.function) {
        const sectionName = this.sectionType.toStr().replaceAll(".", "_");
        return `${this.parentFileName}${sectionName}_${hexU(this.inFileOffset, 6)}`;
      }
    }

    const suffix = this._defaultName_suffix();

    if (GlobalConfig.LEGACY_SYM_ADDR_ZERO_PADDING) return `${hexU(this.address, 6)}${suffix}`;
    return `${hexU(this.address, 8)}${suffix}`;
  }

  _defaultName_sectionPrefix(symType) {
    if (
      symType === SymbolSpecialType.function ||
      symType === SymbolSpecialType.branchlabel ||
      symType === SymbolSpecialType.jumptablelabel ||
      symType === SymbolSpecialType.jumptable ||
      symType === SymbolSpecialType.gccexcepttable ||
      symType === SymbolSpecialType.gccexcepttablelabel
    ) {
      return "";
    }

    if (GlobalConfig.AUTOGENERATED_NAMES_BASED_ON_SECTION_TYPE) {
      if (this.sectionType === FileSectionType.Rodata) return "RO_";
      else if (this.sectionType === FileSectionType.Bss) return "B_";
      else if (this.sectionType === FileSectionType.Text) return "T_";
      else if (this.sectionType === FileSectionType.Reloc) return "REL_";
      if (this.sectionType === FileSectionType.GccExceptTable) return "EHTBL_";
    }
    return "D_";
  }

  _defaultName_typePrefix(symType) {
    if (symType === SymbolSpecialType.function) return "func_";
    if (symType === SymbolSpecialType.branchlabel || symType === SymbolSpecialType.jumptablelabel) return ".L";
    if (symType === SymbolSpecialType.jumptable) return "jtbl_";
    if (symType === SymbolSpecialType.gccexcepttable) return "ehtbl_";
    if (symType === SymbolSpecialType.gccexcepttablelabel) return "$LEH_";

    if (GlobalConfig.AUTOGENERATED_NAMES_BASED_ON_DATA_TYPE) {
      if (this.isFloat()) return "FLT_";
      else if (this.isDouble()) return "DBL_";
      else if (this.isString()) return "STR_";
      else if (this.isPascalString()) return "PSTR_";
    }
    return "";
  }

  getDefaultName() {
    const currentType = this.getTypeSpecial();
    const uniqueIdentifier = this._defaultName_uniqueIdentifier(currentType);
    const sectionPrefix = this._defaultName_sectionPrefix(currentType);
    const typePrefix = this._defaultName_typePrefix(currentType);
    return `${sectionPrefix}${typePrefix}${uniqueIdentifier}`;
  }

  getNameUnquoted() {
    let name;
    if (this.nameGetCallback !== null) name = this.nameGetCallback(this);
    else if (this.name === null) name = this.getDefaultName();
    else name = this.name;
    return name;
  }

  getName() {
    const name = this.getNameUnquoted();
    if (name.includes("@") || name.includes("<") || name.includes("\\") || name.includes("-") || name.includes("+") || (atLeast("1.42.0") && anyPySpace(name))) {
      return `"${name}"`;
    }
    return name;
  }

  setNameIfUnset(name) {
    if (this.name === null) {
      this.name = name;
      return true;
    }
    return false;
  }

  setNameGetCallback(callback) {
    this.nameGetCallback = callback;
  }

  setNameGetCallbackIfUnset(callback) {
    if (this.nameGetCallback === null) this.nameGetCallback = callback;
  }

  getNameEnd() {
    return this.nameEnd;
  }

  getSize() {
    if (this.userDeclaredSize !== null) return this.userDeclaredSize;
    if (this.autodetectedSize !== null) return this.autodetectedSize;

    const currentType = this.getTypeSpecial();

    // Infer size based on user-declared type
    if (currentType !== null && !isSymbolSpecialType(currentType)) {
      for (const [, info] of ACCESS_KIND_TABLE) {
        if (info.typeMatchesAccess(currentType)) {
          const size = info.size;
          if (size !== null) return size;
          break;
        }
      }
    }

    // Infer size based on instruction access type
    if (this.accessType !== null) {
      const size = accessKindInfo(this.accessType).size;
      if (size !== null) return size;
    }

    // Infer size based on symbol's address alignment
    if (this.vram % 4 === 0) return 4;
    if (this.vram % 2 === 0) return 2;
    return 1;
  }

  getVrom() {
    if (this.vromAddress === null) return 0;
    return this.vromAddress;
  }

  setSizeIfUnset(size) {
    if (size <= 0) return false;
    if (this.userDeclaredSize === null) {
      this.userDeclaredSize = size;
      return true;
    }
    return false;
  }

  getTypeSpecial() {
    if (this.userDeclaredType !== null) return this.userDeclaredType;
    return this.autodetectedType;
  }

  getType() {
    const currentType = this.getTypeSpecial();
    if (currentType === null) {
      if (this.accessType !== null && this.unsignedAccessType !== null) {
        const typeInfo = accessKindInfo(this.accessType);
        const t = this.unsignedAccessType ? typeInfo.typeUnsigned : typeInfo.typeSigned;
        if (t !== null) return t;
      }
      return "";
    }
    if (isSymbolSpecialType(currentType)) return currentType.toStr();
    return currentType;
  }

  setTypeSpecial(newType, isAutogenerated) {
    if (newType === undefined) newType = null;
    if (isAutogenerated) this.autodetectedType = newType;
    else this.userDeclaredType = newType;
  }

  setTypeIfUnset(newType, isAutogenerated) {
    if (this.hasNoType()) {
      this.setTypeSpecial(newType, isAutogenerated);
      return true;
    }
    return false;
  }

  setAccessTypeIfUnset(accessType, unsignedMemoryAccess) {
    if (this.accessType === null && this.unsignedAccessType === null) {
      this.accessType = accessType;
      this.unsignedAccessType = unsignedMemoryAccess;
      return true;
    }
    return false;
  }

  setFirstLoAccessIfUnset(loOffset) {
    if (this.firstLoAccess === null) this.firstLoAccess = loOffset;
  }

  getSymbolPlusOffset(address) {
    if (this.address === address) return this.getName();
    if (this.address > address) return `${this.getName()} - 0x${hexU(this.address - address)}`;
    return `${this.getName()} + 0x${hexU(address - this.address)}`;
  }

  getLabelMacro(isInMiddleLabel = false) {
    if (!GlobalConfig.ASM_USE_SYMBOL_LABEL) return null;
    let label = "";
    if (GlobalConfig.ASM_COMMENT) {
      if (this.isStatic()) label += `/* static variable */${GlobalConfig.LINE_ENDS}`;
      if (this.isAutogeneratedPad()) {
        let mainSymbolInfo = "";
        if (this.autoCreatedPadMainSymbol !== null) mainSymbolInfo = ` (generated by the size of ${this.autoCreatedPadMainSymbol.getName()})`;
        label += `/* Automatically generated and unreferenced pad${mainSymbolInfo} */${GlobalConfig.LINE_ENDS}`;
      }
    }

    const currentType = this.getTypeSpecial();
    if (currentType === SymbolSpecialType.jumptablelabel) label += GlobalConfig.ASM_JTBL_LABEL;
    else if (currentType === SymbolSpecialType.gccexcepttablelabel) label += GlobalConfig.ASM_EHTBL_LABEL;
    else if (typeof currentType === "string" && gKnownTypes.has(currentType)) label += GlobalConfig.ASM_DATA_LABEL;
    else if (this.sectionType === FileSectionType.Text) {
      if (isInMiddleLabel) label += GlobalConfig.ASM_TEXT_ALT_LABEL;
      else label += GlobalConfig.ASM_TEXT_LABEL;
    } else label += GlobalConfig.ASM_DATA_LABEL;
    return label;
  }

  isAutogeneratedPad() {
    return this.isAutoCreatedPad && this.referenceCounter === 0 && this.isAutogenerated;
  }

  getReferenceeSymbols() {
    if (!GlobalConfig.ASM_COMMENT || !GlobalConfig.ASM_REFERENCEE_SYMBOLS) return "";

    if (this.referenceFunctions.size) {
      let output = "/* Functions referencing this symbol:";
      for (const sym of this.referenceFunctions) output += ` ${sym.getName()}`;
      return `${output} */${GlobalConfig.LINE_ENDS}`;
    }

    if (this.referenceSymbols.size) {
      let output = "/* Symbols referencing this symbol:";
      for (const sym of this.referenceSymbols) output += ` ${sym.getName()}`;
      return `${output} */${GlobalConfig.LINE_ENDS}`;
    }
    return "";
  }

  getAlignment() {
    if (this.alignmentShift !== null) return 2 ** this.alignmentShift;
    return null;
  }

  setAlignment(alignment) {
    if (alignment <= 0) {
      Utils.eprint(`
Warning: Tried to set an alignment of \`${alignment}\` to symbol \`${this.getName()}\` (\`0x${hexU(this.vram, 8)}\`), but the given alignment is negative.
This alignment will be discarded.
`);
      return;
    }
    // Calculate the alignment shift value: (alignment & -alignment).bit_length() - 1
    let low = alignment;
    let alignmentShift = 0;
    while (low % 2 === 0) {
      low /= 2;
      alignmentShift++;
    }
    if (2 ** alignmentShift !== alignment) {
      Utils.eprint(`
Warning: Tried to set an alignment of \`${alignment}\` to symbol \`${this.getName()}\` (\`0x${hexU(this.vram, 8)}\`), but the given alignment isn't a power of two.
This alignment will be discarded.
`);
      return;
    }
    const div = 2 ** alignmentShift;
    const alignedVram = Math.floor(this.vram / div) * div;
    if (alignedVram !== this.vram) {
      Utils.eprint(`
Warning: Tried to set an alignment of \`${alignment}\` to symbol \`${this.getName()}\` (\`0x${hexU(this.vram, 8)}\`), but the given alignment does not match the alignment the symbol currently has.
This alignment will be discarded.
`);
      return;
    }
    this.alignmentShift = alignmentShift;
  }

  static getCsvHeader() {
    let output = "address,name,getName,getNameEnd,";
    output += "userDeclaredType,autodetectedType,getType,";
    output += "accessType,";
    output += "userDeclaredSize,";
    output += "autodetectedSize,";
    output += "getSize,getVrom,sectionType,";
    output += "isDefined,isUserDeclared,isAutogenerated,";
    output += "isMaybeString,failedStringDecoding,isMaybePascalString,failedPascalStringDecoding,";
    output += "referenceCounter,";
    output += "parentFunction,";
    output += "parentFileName,";
    output += "inFileOffset,";
    output += "overlayCategory,unknownSegment,";
    output += "isGot,isGotGlobal,isGotLocal,gotIndex,accessedAsGpRel,";
    output += "firstLoAccess,isAutogeneratedPad,autoCreatedPadMainSymbol,isElfNotype,";
    output += "isAutocreatedSymFromOtherSizedSym,isMips1Double,visibility";
    return output;
  }

  toCsv() {
    let output = `0x${hexU(this.address, 8)},${pyStr(this.name)},${this.getName()},${pyStr(this.getNameEnd())},`;

    output += `${pyStr(this.userDeclaredType)},${pyStr(this.autodetectedType)},${this.getType()},`;

    if (this.accessType === null) output += "None,";
    else output += `${this.accessType.name},`;

    if (this.userDeclaredSize === null) output += "None,";
    else output += `0x${hexU(this.userDeclaredSize)},`;
    if (this.autodetectedSize === null) output += "None,";
    else output += `0x${hexU(this.autodetectedSize)},`;

    output += `0x${hexU(this.getSize())},0x${hexU(this.getVrom())},${this.sectionType.toStr()},`;
    output += `${pyStr(this.isDefined)},${pyStr(this.isUserDeclared)},${pyStr(this.isAutogenerated)},`;
    output += `${pyStr(this.isMaybeString)},${pyStr(this.failedStringDecoding)},${pyStr(this.isMaybePascalString)},${pyStr(this.failedPascalStringDecoding)},`;
    output += `${this.referenceCounter},`;

    if (this.parentFunction !== null) output += `${this.parentFunction.getName()},`;
    else output += "None,";
    if (this.parentFileName !== null) output += `${this.parentFileName},`;
    else output += "None,";
    if (this.inFileOffset !== null) output += `${this.inFileOffset},`;
    else output += "None,";

    output += `${pyStr(this.overlayCategory)},${pyStr(this.unknownSegment)},`;
    output += `${pyStr(this.isGot)},${pyStr(this.isGotGlobal)},${pyStr(this.isGotLocal)},${pyStr(this.gotIndex)},${pyStr(this.accessedAsGpRel)},`;
    let autoCreatedPadMainSymbolName = "";
    if (this.autoCreatedPadMainSymbol !== null) autoCreatedPadMainSymbolName = this.autoCreatedPadMainSymbol.getName();
    output += `${pyStr(this.firstLoAccess)},${pyStr(this.isAutogeneratedPad())},${autoCreatedPadMainSymbolName},${pyStr(this.isElfNotype)},`;
    output += `${pyStr(this.isAutocreatedSymFromOtherSizedSym)},${pyStr(this.isMips1Double)},${pyStr(this.visibility)}`;
    return output;
  }

  equals(other) {
    return symEq(this, other);
  }

  toString() {
    return `0x${hexU(this.address, 8)} ${pyStr(this.name)} (${this.getName()})`;
  }
}
