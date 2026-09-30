// JS binding for the rabbitizer MIPS instruction decoder, built from its C
// library to WASM (one module per pinned rabbitizer version). The API mirrors
// the Python `rabbitizer` extension module of the same version: same class,
// method, property and enum member names, same argument order, same return
// values (None -> null, tuples -> arrays) and the same errors for the same
// misuse (Python exception names are kept as the JS error `name`).
//
// Everything is synchronous: the WASM module is compiled and instantiated
// with the synchronous WebAssembly API the first time a version is loaded.

import { readFileSync } from "node:fs";

/** Rabbitizer versions shipped in wasm/, newest first. */
export const VERSIONS = Object.freeze(["1.16.2", "1.14.3", "1.13.0"]);
export const DEFAULT_VERSION = VERSIONS[0];

// ---------------------------------------------------------------------------
// Errors (named after the Python exceptions the extension module raises)
// ---------------------------------------------------------------------------

export class RuntimeError extends Error {
  constructor(message) { super(message); this.name = "RuntimeError"; }
}
export class ValueError extends Error {
  constructor(message) { super(message); this.name = "ValueError"; }
}
export class IndexError extends Error {
  constructor(message) { super(message); this.name = "IndexError"; }
}
export class OverflowError extends Error {
  constructor(message) { super(message); this.name = "OverflowError"; }
}
export class AssertionError extends Error {
  constructor(message) { super(message); this.name = "AssertionError"; }
}
export class MemoryError extends Error {
  constructor(message) { super(message); this.name = "MemoryError"; }
}

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * An enum member. The loader creates exactly one object per member of each
 * enum type of a version, so members compare by identity (`===`) and work as
 * Map keys. Python compares members by (enum type, value) and orders them by
 * value; use `.value` for ordering and `.equals()` for Python's `==`.
 */
export class Enum {
  constructor(enumType, name, value) {
    if (typeof enumType !== "string" || typeof name !== "string") {
      throw new TypeError("Enum(enumType: str, name: str, value: int)");
    }
    this.enumType = enumType;
    this.name = name;
    this.value = checkInt(value, "value");
    Object.freeze(this);
  }

  /** Python `==`: same enum type and same value. */
  equals(other) {
    return other instanceof Enum && other.enumType === this.enumType && other.value === this.value;
  }

  toString() {
    return `<${this.enumType}: ${this.name} (${this.value})>`;
  }

  [INSPECT]() {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// Argument helpers (PyArg_ParseTuple format semantics)
// ---------------------------------------------------------------------------

function typeName(v) {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "object" || typeof v === "function") return v.constructor?.name ?? typeof v;
  return typeof v;
}

// "i": a C int; TypeError for a non-integer, OverflowError outside int range.
function checkInt(v, what) {
  if (typeof v === "number" && Number.isInteger(v)) {
    if (v < -2147483648 || v > 2147483647) {
      throw new OverflowError(`signed integer is greater than maximum (${what})`);
    }
    return v;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return checkInt(Number(v), what);
  throw new TypeError(`'${typeName(v)}' object cannot be interpreted as an integer (${what})`);
}

// "I" / "H": an unsigned C int / short with no overflow check (the value is
// truncated to its low bits, as CPython does for these formats).
function uint32(v, what) {
  if (typeof v === "number" && Number.isInteger(v)) return v >>> 0;
  if (typeof v === "bigint") return Number(BigInt.asUintN(32, v));
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new TypeError(`'${typeName(v)}' object cannot be interpreted as an integer (${what})`);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const cache = new Map();

/**
 * Loads a rabbitizer version synchronously and returns its module namespace
 * (the equivalent of `import rabbitizer` in Python). Each version is loaded
 * once and shared: like the Python module, `config` is global per version.
 * @param {string} [version]
 */
export function loadRabbitizerSync(version = DEFAULT_VERSION) {
  let ns = cache.get(version);
  if (ns) return ns;
  if (!VERSIONS.includes(version)) {
    throw new Error(`romdev-rabbitizer: unknown rabbitizer version '${version}' (have ${VERSIONS.join(", ")})`);
  }
  const bytes = readFileSync(new URL(`../wasm/rabbitizer-${version}.wasm`, import.meta.url));
  ns = createNamespace(new WebAssembly.Module(bytes), version);
  cache.set(version, ns);
  return ns;
}

/**
 * Async form of loadRabbitizerSync (same namespace object).
 * @param {string} [version]
 */
export async function loadRabbitizer(version = DEFAULT_VERSION) {
  return loadRabbitizerSync(version);
}

function createNamespace(wasmModule, expectedVersion) {
  let memory = null;
  const imports = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (imp.kind !== "function") continue;
    (imports[imp.module] ??= {})[imp.name] =
      imp.name === "emscripten_notify_memory_growth"
        ? () => refreshViews()
        : () => { throw new RuntimeError(`romdev-rabbitizer: unexpected WASM import call ${imp.module}.${imp.name}`); };
  }
  const instance = new WebAssembly.Instance(wasmModule, imports);
  const ex = instance.exports;
  memory = ex.memory;
  ex._initialize?.();

  // --- memory helpers ------------------------------------------------------

  // Views over WASM memory; memory growth detaches them, and the module
  // reports growth through emscripten_notify_memory_growth.
  let u8 = new Uint8Array(memory.buffer);
  let h32 = new Int32Array(memory.buffer);
  function refreshViews() {
    u8 = new Uint8Array(memory.buffer);
    h32 = new Int32Array(memory.buffer);
  }
  const heap = () => (u8.buffer !== memory.buffer ? (refreshViews(), u8) : u8);
  const utf8Decoder = new TextDecoder("utf-8");
  const utf8Encoder = new TextEncoder();

  function readBytesAsString(ptr, len) {
    const h = heap();
    let s = "";
    for (let i = 0; i < len; i++) {
      const c = h[ptr + i];
      if (c >= 0x80) return utf8Decoder.decode(h.subarray(ptr, ptr + len));
      s += String.fromCharCode(c);
    }
    return s;
  }

  function readCString(ptr) {
    if (ptr === 0) return null;
    const h = heap();
    let end = ptr;
    while (h[end] !== 0) end++;
    return readBytesAsString(ptr, end - ptr);
  }

  function malloc(size) {
    const p = ex.rab_malloc(size);
    if (p === 0) throw new MemoryError("romdev-rabbitizer: WASM malloc failed");
    return p;
  }

  // A reusable scratch buffer for strings passed into C.
  let inBuf = malloc(256);
  let inCap = 256;
  // Writes `str` as UTF-8 plus a NUL terminator; returns the byte length.
  function writeInString(str) {
    const n = str.length;
    let ascii = true;
    for (let i = 0; i < n; i++) {
      if (str.charCodeAt(i) >= 0x80) { ascii = false; break; }
    }
    let bytes = null;
    const len = ascii ? n : (bytes = utf8Encoder.encode(str)).length;
    if (len + 1 > inCap) {
      ex.rab_free(inBuf);
      inCap = Math.max(len + 1, inCap * 2);
      inBuf = malloc(inCap);
    }
    const h = heap();
    if (ascii) {
      for (let i = 0; i < n; i++) h[inBuf + i] = str.charCodeAt(i);
    } else {
      h.set(bytes, inBuf);
    }
    h[inBuf + len] = 0;
    return len;
  }

  let outBuf = malloc(1024);
  let outCap = 1024;

  // --- enums ---------------------------------------------------------------

  // Per enum type: `list` indexed like the C enumvalues array (the Python
  // binding looks members up by that index) and `ns`, the attribute object.
  const enumTypes = {};
  for (let t = 0, tc = ex.rab_enum_table_count(); t < tc; t++) {
    const typeNameStr = readCString(ex.rab_enum_table_name(t));
    const list = [];
    const ns = {};
    for (let i = 0, n = ex.rab_enum_count(t); i < n; i++) {
      const member = new Enum(typeNameStr, readCString(ex.rab_enum_name(t, i)), ex.rab_enum_value(t, i));
      list.push(member);
      ns[member.name] = member;
    }
    enumTypes[typeNameStr] = { list, ns };
  }
  const E = (name) => enumTypes[name];
  const InstrIdList = E("InstrId").list;
  const InstrIdTypeList = E("InstrIdType").list;
  const AccessTypeList = E("AccessType").list;
  const TrinaryList = E("TrinaryValue").list;
  const AbiList = E("Abi").list;
  const GprO32List = E("RegGprO32").list;
  const GprN32List = E("RegGprN32").list;
  const Cop1O32List = E("RegCop1O32").list;
  const Cop1N32List = E("RegCop1N32").list;
  const Cop1N64List = E("RegCop1N64").list;
  const ABI_N32 = E("Abi").ns.N32.value;
  const ABI_N64 = E("Abi").ns.N64.value;

  const isEnumOf = (v, type) => v instanceof Enum && v.enumType === type;

  const Abi = Object.freeze(Object.assign(Object.create(null), E("Abi").ns, {
    /** Abi.fromStr(name: str|None) -> Enum */
    fromStr(name) {
      if (name === null || name === undefined) return AbiList[ex.rab_abi_fromStr(0)];
      if (typeof name !== "string") throw new TypeError(`argument 1 must be str or None, not ${typeName(name)}`);
      writeInString(name);
      return AbiList[ex.rab_abi_fromStr(inBuf)];
    },
  }));

  const InstrCategory = Object.freeze(Object.assign(Object.create(null), E("InstrCategory").ns, {
    /** InstrCategory.fromStr(name: str|None) -> Enum|None */
    fromStr(name) {
      let r;
      if (name === null || name === undefined) {
        r = ex.rab_instrCategory_fromStr(0);
      } else {
        if (typeof name !== "string") throw new TypeError(`argument 1 must be str or None, not ${typeName(name)}`);
        writeInString(name);
        r = ex.rab_instrCategory_fromStr(inBuf);
      }
      return r < 0 ? null : E("InstrCategory").list[r];
    },
  }));

  const frozenNs = (name) => Object.freeze(Object.assign(Object.create(null), E(name).ns));

  // --- config --------------------------------------------------------------

  // Order matches CONFIG_FIELDS in csrc/rabbitizer_wasm.c.
  const CONFIG_FIELDS = [
    ["regNames_namedRegisters", "bool"],
    ["regNames_gprAbiNames", "abi"],
    ["regNames_fprAbiNames", "abi"],
    ["regNames_userFpcCsr", "bool"],
    ["regNames_vr4300Cop0NamedRegisters", "bool"],
    ["regNames_vr4300RspCop0NamedRegisters", "bool"],
    ["regNames_r4000AllegrexVfpuControlNamedRegisters", "bool"],
    ["pseudos_enablePseudos", "bool"],
    ["pseudos_pseudoBeqz", "bool"],
    ["pseudos_pseudoBnez", "bool"],
    ["pseudos_pseudoB", "bool"],
    ["pseudos_pseudoMove", "bool"],
    ["pseudos_pseudoNot", "bool"],
    ["pseudos_pseudoNeg", "bool"],
    ["pseudos_pseudoNegu", "bool"],
    ["pseudos_pseudoBal", "bool"],
    ["toolchainTweaks_treatJAsUnconditionalBranch", "bool"],
    ["toolchainTweaks_sn64DivFix", "bool"],
    ["toolchainTweaks_gnuMode", "bool"],
    ["misc_opcodeLJust", "int"],
    ["misc_unknownInstrComment", "bool"],
    ["misc_omit0XOnSmallImm", "bool"],
    ["misc_upperCaseImm", "bool"],
    ["misc_expandJalr", "bool"],
  ];

  const config = {};
  CONFIG_FIELDS.forEach(([name, kind], index) => {
    const dotted = name.replace("_", kind === "bool" ? "." : "_");
    let get, set;
    if (kind === "bool") {
      get = () => ex.rab_config_get(index) !== 0;
      set = (v) => {
        if (v === undefined) throw new TypeError(`Cannot delete '${dotted}' attribute`);
        ex.rab_config_set(index, v ? 1 : 0);
      };
    } else if (kind === "abi") {
      get = () => {
        const m = AbiList[ex.rab_config_get(index)];
        if (m === undefined) throw new RuntimeError(`Internal error: invalid enum value for '${name}'`);
        return m;
      };
      set = (v) => {
        if (v === undefined) throw new TypeError(`Cannot delete '${name}' attribute`);
        if (!(v instanceof Enum)) throw new TypeError(`Invalid value for '${name}' attribute`);
        if (v.enumType !== "Abi") throw new ValueError(`Invalid value for '${name}' attribute`);
        ex.rab_config_set(index, v.value);
      };
    } else {
      get = () => ex.rab_config_get(index);
      set = (v) => {
        if (v === undefined) throw new TypeError(`Cannot delete '${name}' attribute`);
        ex.rab_config_set(index, checkInt(v, name));
      };
    }
    Object.defineProperty(config, name, { get, set, enumerable: true });
  });
  Object.preventExtensions(config);

  // --- register enum lookups (RETURN_GPR / DEF_MEMBER_GET_REGCOP1) ---------

  function gprMember(reg) {
    const abi = ex.rab_config_get(1);
    const m = (abi === ABI_N32 || abi === ABI_N64 ? GprN32List : GprO32List)[reg];
    if (m === undefined) throw new RuntimeError("Internal error: invalid RegGpr enum value");
    return m;
  }

  function cop1Member(reg) {
    const abi = ex.rab_config_get(2);
    const m = (abi === ABI_N32 ? Cop1N32List : abi === ABI_N64 ? Cop1N64List : Cop1O32List)[reg];
    if (m === undefined) throw new RuntimeError("Internal error: invalid RegCop1 enum value");
    return m;
  }

  // --- Instruction ---------------------------------------------------------

  // An Instruction object holds its own copy of the C struct as nine int32
  // words (_w0.._w8); each call copies them into a static WASM slot. The
  // struct is plain data in every shipped version (destroy is a no-op), so
  // nothing needs freeing and no finalizer is registered per instruction.
  if (ex.rab_instr_sizeof() !== 36 || ex.rab_instr_offsetof_word() !== 0 ||
      ex.rab_instr_offsetof_uniqueId() !== 8 || ex.rab_instr_offsetof_vram() !== 20) {
    throw new Error("romdev-rabbitizer: unexpected RabbitizerInstruction layout; update src/index.js");
  }
  const SLOT_A = ex.rab_instr_slot(0);
  const SLOT_B = ex.rab_instr_slot(1);
  const A32 = SLOT_A >> 2;
  const B32 = SLOT_B >> 2;

  function toSlot(instr, base) {
    const h = h32;
    h[base] = instr._w0; h[base + 1] = instr._w1; h[base + 2] = instr._w2;
    h[base + 3] = instr._w3; h[base + 4] = instr._w4; h[base + 5] = instr._w5;
    h[base + 6] = instr._w6; h[base + 7] = instr._w7; h[base + 8] = instr._w8;
  }

  function fromSlotA(instr) {
    const h = h32;
    instr._w0 = h[A32]; instr._w1 = h[A32 + 1]; instr._w2 = h[A32 + 2];
    instr._w3 = h[A32 + 3]; instr._w4 = h[A32 + 4]; instr._w5 = h[A32 + 5];
    instr._w6 = h[A32 + 6]; instr._w7 = h[A32 + 7]; instr._w8 = h[A32 + 8];
  }

  // Copies `instr` into slot A and returns the slot address.
  const a = (instr) => (toSlot(instr, A32), SLOT_A);

  const opcodeNames = [];
  function opcodeName(instr) {
    const id = instr._w2;
    let name = opcodeNames[id];
    if (name === undefined) name = opcodeNames[id] = readCString(ex.rab_instr_getOpcodeName(a(instr)));
    return name;
  }

  function checkInstr(instr, what) {
    if (!(instr instanceof Instruction)) {
      throw new TypeError(`argument '${what}' must be rabbitizer.Instruction, not ${typeName(instr)}`);
    }
    return instr;
  }

  const hasFlagProdg = ex.rab_has_flag_r5900ProdgSnAsInvertedRegs() !== 0;

  class Instruction {
    /**
     * Instruction(word, vram=0, category=InstrCategory.CPU)
     * @param {number} word
     * @param {number} [vram]
     * @param {Enum} [category]
     */
    constructor(word, vram = 0, category = undefined) {
      const w = uint32(word, "word");
      const v = uint32(vram, "vram");
      let cat = 0;
      if (category !== undefined) {
        if (!(category instanceof Enum)) {
          throw new TypeError(`argument 3 must be rabbitizer.Enum, not ${typeName(category)}`);
        }
        if (category.enumType !== "InstrCategory") throw new ValueError("Invalid value for 'category' parameter");
        cat = category.value;
      }
      ex.rab_instr_init(SLOT_A, w, v, cat);
      const h = h32;
      /** @internal struct words */
      this._w0 = h[A32]; this._w1 = h[A32 + 1]; this._w2 = h[A32 + 2];
      this._w3 = h[A32 + 3]; this._w4 = h[A32 + 4]; this._w5 = h[A32 + 5];
      this._w6 = h[A32 + 6]; this._w7 = h[A32 + 7]; this._w8 = h[A32 + 8];
    }

    get vram() { return this._w5 >>> 0; }
    set vram(v) { this._w5 = uint32(v, "vram") | 0; }

    get inHandwrittenFunction() { return ex.rab_instr_getInHandwrittenFunction(a(this)) !== 0; }
    set inHandwrittenFunction(v) {
      if (typeof v !== "boolean") throw new TypeError("attribute value type must be bool");
      ex.rab_instr_setInHandwrittenFunction(a(this), v ? 1 : 0);
      fromSlotA(this);
    }

    get rs() { return this.#reg(ex.rab_instr_field_rs(a(this)), "rs", gprMember); }
    get rt() { return this.#reg(ex.rab_instr_field_rt(a(this)), "rt", gprMember); }
    get rd() { return this.#reg(ex.rab_instr_field_rd(a(this)), "rd", gprMember); }
    get sa() { return ex.rab_instr_field_sa(a(this)) >>> 0; }
    get fs() { return this.#reg(ex.rab_instr_field_fs(a(this)), "fs", cop1Member); }
    get ft() { return this.#reg(ex.rab_instr_field_ft(a(this)), "ft", cop1Member); }
    get fd() { return this.#reg(ex.rab_instr_field_fd(a(this)), "fd", cop1Member); }

    #reg(r, name, lookup) {
      if (r < 0) throw new RuntimeError(`'${opcodeName(this)}' instruction does not reference register '${name}'`);
      return lookup(r);
    }

    get uniqueId() {
      const m = InstrIdList[this._w2];
      if (m === undefined) throw new RuntimeError("Internal error: invalid uniqueId enum value");
      return m;
    }

    get instrIdType() {
      const m = InstrIdTypeList[ex.rab_instr_getInstrIdType(a(this))];
      if (m === undefined) throw new RuntimeError("Internal error: invalid instrIdType enum value");
      return m;
    }

    get flag_r5900DisasmAsData() { return TrinaryList[ex.rab_instr_getFlag(a(this), 0)]; }
    set flag_r5900DisasmAsData(v) { ex.rab_instr_setFlag(a(this), 0, trinaryArg(v)); fromSlotA(this); }
    get flag_r5900UseDollar() { return TrinaryList[ex.rab_instr_getFlag(a(this), 1)]; }
    set flag_r5900UseDollar(v) { ex.rab_instr_setFlag(a(this), 1, trinaryArg(v)); fromSlotA(this); }

    getRaw() { return ex.rab_instr_getRaw(a(this)) >>> 0; }

    getImmediate() {
      const p = a(this);
      if (!ex.rab_instr_hasImmediate(p)) this.#noField("immediate");
      return ex.rab_instr_getImmediate(p) >>> 0;
    }

    getProcessedImmediate() {
      const p = a(this);
      if (!ex.rab_instr_hasImmediate(p)) this.#noField("immediate");
      return ex.rab_instr_getProcessedImmediate(p);
    }

    getInstrIndexAsVram() {
      const p = a(this);
      if (!ex.rab_instr_hasLabel(p)) this.#noField("jump label");
      return ex.rab_instr_getInstrIndexAsVram(p) >>> 0;
    }

    getBranchOffset() {
      const p = a(this);
      if (!ex.rab_instr_hasBranchTargetLabel(p)) this.#noField("branch label");
      return ex.rab_instr_getBranchOffset(p);
    }

    getGenericBranchOffset(currentVram) {
      const cv = uint32(currentVram, "currentVram");
      return ex.rab_instr_getGenericBranchOffset(a(this), cv);
    }

    getBranchOffsetGeneric() {
      this.#checkBranchOrJump();
      return ex.rab_instr_getBranchOffsetGeneric(SLOT_A);
    }

    getBranchVramGeneric() {
      this.#checkBranchOrJump();
      return ex.rab_instr_getBranchVramGeneric(SLOT_A) >>> 0;
    }

    #noField(field) {
      throw new RuntimeError(`'${opcodeName(this)}' instruction does not have an '${field}' field`);
    }

    // Leaves this instruction in slot A.
    #checkBranchOrJump() {
      const p = a(this);
      if (!ex.rab_instr_hasLabel(p) && !ex.rab_instr_hasBranchTargetLabel(p)) {
        throw new RuntimeError(`'${opcodeName(this)}' instruction does not not perform a branch or a jump.`);
      }
    }

    /** @returns {Enum|null} */
    getDestinationGpr() {
      const r = ex.rab_instr_getDestinationGpr(a(this));
      return r < 0 ? null : gprMember(r);
    }

    getOpcodeName() { return opcodeName(this); }

    blankOut() {
      ex.rab_instr_blankOut(a(this));
      fromSlotA(this);
    }

    /** @returns {string|null} */
    mapInstrToType() { return readCString(ex.rab_instr_mapInstrToType(a(this))); }

    sameOpcode(other) {
      toSlot(checkInstr(other, "other"), B32);
      return ex.rab_instr_sameOpcode(a(this), SLOT_B) !== 0;
    }

    sameOpcodeButDifferentArguments(other) {
      toSlot(checkInstr(other, "other"), B32);
      return ex.rab_instr_sameOpcodeButDifferentArguments(a(this), SLOT_B) !== 0;
    }

    hasOperand(operand) { return ex.rab_instr_hasOperand(a(this), operandArg(operand)) !== 0; }

    hasOperandAlias(operand) { return ex.rab_instr_hasOperandAlias(a(this), operandArg(operand)) !== 0; }

    getAccessType() { return AccessTypeList[ex.rab_instr_getAccessType(a(this))]; }

    /**
     * disassemble(immOverride=None, extraLJust=0) -> str
     * @param {string|null} [immOverride]
     * @param {number} [extraLJust]
     */
    disassemble(immOverride = null, extraLJust = 0) {
      let immPtr = 0;
      let immLen = 0;
      if (immOverride !== null && immOverride !== undefined) {
        if (typeof immOverride !== "string") {
          throw new TypeError(`argument 1 must be str or None, not ${typeName(immOverride)}`);
        }
        if (immOverride.includes("\0")) throw new ValueError("embedded null character");
        immLen = writeInString(immOverride);
        immPtr = inBuf;
      }
      const lj = extraLJust === 0 ? 0 : checkInt(extraLJust, "extraLJust");
      const p = a(this);
      let n = ex.rab_instr_disassemble(p, outBuf, outCap, immPtr, immLen, lj);
      if (n < 0 && n !== -2147483648) {
        ex.rab_free(outBuf);
        outCap = Math.max(-n, outCap * 2);
        outBuf = malloc(outCap);
        n = ex.rab_instr_disassemble(p, outBuf, outCap, immPtr, immLen, lj);
      }
      if (n === -2147483648) {
        throw new AssertionError(
          "Decoded instruction does not fit in the allocated buffer.\n" +
          "This will produce a memory corruption error.\n" +
          "This is not an user error, please report this bug.\n" +
          `    word:              0x${this.getRaw().toString(16)}\n`,
        );
      }
      return readBytesAsString(outBuf, n);
    }

    toString() { return this.disassemble(); }

    [INSPECT]() {
      return `rabbitizer.Instruction(0x${this.getRaw().toString(16).toUpperCase().padStart(8, "0")}) # ${this.disassemble()}`;
    }
  }

  if (hasFlagProdg) {
    Object.defineProperty(Instruction.prototype, "flag_r5900ProdgSnAsInvertedRegs", {
      get() { return TrinaryList[ex.rab_instr_getFlag(a(this), 2)]; },
      set(v) { ex.rab_instr_setFlag(a(this), 2, trinaryArg(v)); fromSlotA(this); },
      configurable: true,
    });
  }

  // Predicates: RabbitizerInstruction_<name> and RabbitizerInstrDescriptor_<name>.
  const INSTR_BOOLS = [
    "outputsToGprZero", "isImplemented", "isLikelyHandwritten", "isNop", "isUnconditionalBranch",
    "isFunctionCall", "isReturn", "isJumptableJump", "isJrRa", "isJrNotRa", "hasDelaySlot", "isValid",
  ];
  const DESC_BOOLS = [
    "isUnknownType", "isJType", "isIType", "isRType", "isRegimmType", "isBranch", "isBranchLikely",
    "isJump", "isJumpWithAddress", "isTrap", "isFloat", "isDouble", "isUnsigned", "modifiesRs",
    "modifiesRt", "modifiesRd", "readsRs", "readsRt", "readsRd", "readsHI", "readsLO", "modifiesHI",
    "modifiesLO", "modifiesFs", "modifiesFt", "modifiesFd", "readsFs", "readsFt", "readsFd",
    "notEmitedByCompilers", "notEmittedByCompilers", "canBeHi", "canBeLo", "doesLink",
    "doesDereference", "doesLoad", "doesStore", "maybeIsMove", "isPseudo", "doesUnsignedMemoryAccess",
  ];
  for (const [prefix, names] of [["rab_ib_", INSTR_BOOLS], ["rab_db_", DESC_BOOLS]]) {
    for (const name of names) {
      const fn = ex[prefix + name];
      if (typeof fn !== "function") throw new Error(`romdev-rabbitizer: WASM export ${prefix + name} missing`);
      Object.defineProperty(Instruction.prototype, name, {
        value: { [name]() { return fn(a(this)) !== 0; } }[name],
        writable: true,
        configurable: true,
      });
    }
  }

  function trinaryArg(v) {
    if (v === undefined || v === null) throw new ValueError("NULL passed for 'value' parameter?");
    if (!isEnumOf(v, "TrinaryValue") || v.value < 0) throw new ValueError("Invalid value for 'value' parameter");
    return v.value;
  }

  function operandArg(v) {
    if (!(v instanceof Enum)) throw new TypeError(`argument 1 must be rabbitizer.Enum, not ${typeName(v)}`);
    if (v.enumType !== "OperandType") throw new ValueError("Invalid value for 'operand' parameter");
    return v.value;
  }

  // --- TrackedRegisterState / LoPairingInfo / JrRegData --------------------

  // Order matches rab_state_field in csrc/rabbitizer_wasm.c.
  const STATE_FIELDS = [
    ["registerNum", "int"], ["hasLuiValue", "bool"], ["luiOffset", "int"], ["luiSetOnBranchLikely", "bool"],
    ["hasGpGot", "bool"], ["gpGotOffset", "int"], ["hasLoValue", "bool"], ["loOffset", "int"],
    ["dereferenced", "bool"], ["dereferenceOffset", "int"], ["checkedForBranching", "bool"],
    ["lastBranchOffset", "int"], ["value", "uint"],
  ];
  const FROM_C = Symbol("fromC");

  // Snapshot of one register's tracked state; read-only, like the Python type.
  class TrackedRegisterState {
    constructor(registerNum) {
      if (registerNum !== FROM_C) ex.rab_state_init(checkInt(registerNum, "registerNum"));
      for (let i = 0; i < STATE_FIELDS.length; i++) {
        const [name, kind] = STATE_FIELDS[i];
        const raw = ex.rab_state_field(i);
        this[name] = kind === "bool" ? raw !== 0 : kind === "int" ? raw | 0 : raw >>> 0;
      }
      Object.freeze(this);
    }
  }

  class LoPairingInfo {
    #instrOffset;
    #value;
    #shouldProcess;
    #isGpRel;
    #isGpGot;

    constructor(fromC = undefined) {
      if (fromC !== FROM_C) ex.rab_loPairing_init();
      this.#instrOffset = ex.rab_loPairing_instrOffset();
      this.#value = ex.rab_loPairing_valueHi() * 4294967296 + (ex.rab_loPairing_valueLo() >>> 0);
      this.#shouldProcess = ex.rab_loPairing_shouldProcess() !== 0;
      this.#isGpRel = ex.rab_loPairing_isGpRel() !== 0;
      this.#isGpGot = ex.rab_loPairing_isGpGot() !== 0;
    }

    get instrOffset() { return this.#instrOffset; }
    get value() { return this.#value; }
    get shouldProcess() { return this.#shouldProcess; }
    set shouldProcess(v) { this.#shouldProcess = boolMember(v); }
    get isGpRel() { return this.#isGpRel; }
    set isGpRel(v) { this.#isGpRel = boolMember(v); }
    get isGpGot() { return this.#isGpGot; }
    set isGpGot(v) { this.#isGpGot = boolMember(v); }
  }

  function boolMember(v) {
    if (typeof v !== "boolean") throw new TypeError("attribute value type must be bool");
    return v;
  }

  class JrRegData {
    #hasInfo;
    #offset;
    #address;
    #checkedForBranching;
    #lastBranchOffset;

    constructor(fromC = undefined) {
      if (fromC !== FROM_C) ex.rab_jrRegData_init();
      this.#hasInfo = ex.rab_jrRegData_hasInfo() !== 0;
      this.#offset = ex.rab_jrRegData_offset();
      this.#address = ex.rab_jrRegData_address() >>> 0;
      this.#checkedForBranching = ex.rab_jrRegData_checkedForBranching() !== 0;
      this.#lastBranchOffset = ex.rab_jrRegData_lastBranchOffset();
    }

    hasInfo() { return this.#hasInfo; }
    offset() { return this.#offset; }
    address() { return this.#address; }
    checkedForBranching() { return this.#checkedForBranching; }
    lastBranchOffset() { return this.#lastBranchOffset; }
  }

  // --- RegistersTracker ----------------------------------------------------

  const trackerRegistry = new FinalizationRegistry((ptr) => ex.rab_tracker_free(ptr));
  const REGISTER_COUNT = ex.rab_tracker_register_count();
  const outView = () => new DataView(memory.buffer, ex.rab_out_ptr(), 16);

  class RegistersTracker {
    /** RegistersTracker(other: RegistersTracker|None=None) */
    constructor(other = null) {
      let otherPtr = 0;
      if (other !== null && other !== undefined) {
        if (!(other instanceof RegistersTracker)) {
          throw new TypeError(`argument must be RegistersTracker or None, not ${typeName(other)}`);
        }
        otherPtr = other._ptr;
      }
      const p = ex.rab_tracker_new(otherPtr);
      if (p === 0) throw new MemoryError("romdev-rabbitizer: WASM malloc failed");
      /** @internal */
      this._ptr = p;
      trackerRegistry.register(this, p, this);
    }

    /** Frees the WASM-side struct now (not in the Python API). */
    free() {
      if (this._ptr !== 0) {
        trackerRegistry.unregister(this);
        ex.rab_tracker_free(this._ptr);
        this._ptr = 0;
      }
    }

    [Symbol.dispose]() { this.free(); }

    moveRegisters(instr) { return ex.rab_tracker_moveRegisters(this._ptr, a(checkInstr(instr, "instr"))) !== 0; }

    overwriteRegisters(instr, instrOffset) {
      ex.rab_tracker_overwriteRegisters(this._ptr, a(checkInstr(instr, "instr")), checkInt(instrOffset, "instrOffset"));
    }

    unsetRegistersAfterFuncCall(instr, prevInstr) {
      toSlot(checkInstr(prevInstr, "prevInstr"), B32);
      ex.rab_tracker_unsetRegistersAfterFuncCall(this._ptr, a(checkInstr(instr, "instr")), SLOT_B);
    }

    /** @returns {number|null} */
    getAddressIfCanSetType(instr, instrOffset) {
      const ok = ex.rab_tracker_getAddressIfCanSetType(this._ptr, a(checkInstr(instr, "instr")), checkInt(instrOffset, "instrOffset"));
      return ok ? outView().getUint32(4, true) : null;
    }

    /** @deprecated use getJrRegData. @returns {[number, number]|null} */
    getJrInfo(instr) {
      const ok = ex.rab_tracker_getJrInfo(this._ptr, a(checkInstr(instr, "instr")));
      if (!ok) return null;
      const dv = outView();
      return [dv.getInt32(0, true), dv.getUint32(4, true)];
    }

    getJrRegData(instr) {
      ex.rab_tracker_getJrRegData(this._ptr, a(checkInstr(instr, "instr")));
      return new JrRegData(FROM_C);
    }

    processLui(instr, instrOffset, prevInstr = null) {
      let prev = 0;
      if (prevInstr !== null && prevInstr !== undefined) {
        toSlot(checkInstr(prevInstr, "prevInstr"), B32);
        prev = SLOT_B;
      }
      ex.rab_tracker_processLui(this._ptr, a(checkInstr(instr, "instr")), checkInt(instrOffset, "instrOffset"), prev);
    }

    processGpLoad(instr, instrOffset) {
      ex.rab_tracker_processGpLoad(this._ptr, a(checkInstr(instr, "instr")), checkInt(instrOffset, "instrOffset"));
    }

    /** @returns {number|null} */
    getLuiOffsetForConstant(instr) {
      const ok = ex.rab_tracker_getLuiOffsetForConstant(this._ptr, a(checkInstr(instr, "instr")));
      return ok ? outView().getInt32(0, true) : null;
    }

    processConstant(instr, value, instrOffset) {
      ex.rab_tracker_processConstant(this._ptr, a(checkInstr(instr, "instr")), uint32(value, "value"), checkInt(instrOffset, "instrOffset"));
    }

    /** @deprecated use preprocessLoAndGetInfo. @returns {[number, boolean, boolean]} */
    getLuiOffsetForLo(instr, instrOffset) {
      const ok = ex.rab_tracker_getLuiOffsetForLo(this._ptr, a(checkInstr(instr, "instr")), checkInt(instrOffset, "instrOffset"));
      const dv = outView();
      return [dv.getInt32(0, true), dv.getInt32(8, true) !== 0, ok !== 0];
    }

    preprocessLoAndGetInfo(instr, instrOffset) {
      ex.rab_tracker_preprocessLoAndGetInfo(this._ptr, a(checkInstr(instr, "instr")), checkInt(instrOffset, "instrOffset"));
      return new LoPairingInfo(FROM_C);
    }

    processLo(instr, value, instrOffset) {
      ex.rab_tracker_processLo(this._ptr, a(checkInstr(instr, "instr")), uint32(value, "value"), checkInt(instrOffset, "instrOffset"));
    }

    processBranch(instr, instrOffset) {
      ex.rab_tracker_processBranch(this._ptr, a(checkInstr(instr, "instr")), checkInt(instrOffset, "instrOffset"));
    }

    hasLoButNoHi(instr) { return ex.rab_tracker_hasLoButNoHi(this._ptr, a(checkInstr(instr, "instr"))) !== 0; }

    /** Python `tracker[index]`: a TrackedRegisterState snapshot. */
    __getitem__(index) {
      const i = checkInt(index, "index");
      if (i < 0 || i >= REGISTER_COUNT) throw new IndexError("Index must be a value between 0 and 31");
      ex.rab_state_fromTracker(this._ptr, i);
      return new TrackedRegisterState(FROM_C);
    }

    getItem(index) { return this.__getitem__(index); }
  }

  // --- Utils ---------------------------------------------------------------

  const Utils = Object.freeze({
    from2Complement(number, bits) {
      return ex.rab_utils_from2Complement(uint32(number, "number"), checkInt(bits, "bits"));
    },

    escapeString(src) {
      if (typeof src !== "string") throw new TypeError(`argument 1 must be str, not ${typeName(src)}`);
      const srcSize = writeInString(src);
      if (srcSize === 0) return "";
      const dstSize = 2 * srcSize;
      const dst = malloc(dstSize);
      try {
        const wrote = ex.rab_utils_escapeString(dst, dstSize, inBuf, srcSize) >>> 0;
        if (wrote > dstSize) throw new RuntimeError("Internal error on 'escapeString'");
        return readBytesAsString(dst, wrote);
      } finally {
        ex.rab_free(dst);
      }
    },

    floatRepr_32From16(hex_repr) {
      return ex.rab_utils_floatRepr_32From16(uint32(hex_repr, "hex_repr") & 0xffff) >>> 0;
    },
  });

  // --- namespace -----------------------------------------------------------

  const versionStr = readCString(ex.rab_version_str());
  if (versionStr !== expectedVersion) {
    throw new Error(`romdev-rabbitizer: wasm/rabbitizer-${expectedVersion}.wasm reports version ${versionStr}`);
  }

  return Object.freeze({
    __version__: versionStr,
    __version_info__: Object.freeze([ex.rab_version_major(), ex.rab_version_minor(), ex.rab_version_patch()]),
    __author__: readCString(ex.rab_version_author()),

    Utils,
    config,

    Enum,
    Abi,
    InstrCategory,
    InstrId: frozenNs("InstrId"),
    InstrIdType: frozenNs("InstrIdType"),
    OperandType: frozenNs("OperandType"),
    AccessType: frozenNs("AccessType"),
    RegGprO32: frozenNs("RegGprO32"),
    RegGprN32: frozenNs("RegGprN32"),
    RegCop1O32: frozenNs("RegCop1O32"),
    RegCop1N32: frozenNs("RegCop1N32"),
    RegCop1N64: frozenNs("RegCop1N64"),
    TrinaryValue: frozenNs("TrinaryValue"),

    Instruction,
    LoPairingInfo,
    TrackedRegisterState,
    RegistersTracker,
    JrRegData,

    RuntimeError,
    ValueError,
    IndexError,
    OverflowError,
    AssertionError,
    MemoryError,
  });
}
