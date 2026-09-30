/* SPDX-License-Identifier: MIT */
/*
 * Flat C export layer over the rabbitizer C library, compiled together with it
 * into one standalone WASM module per rabbitizer version. src/index.js wraps
 * these exports in classes that mirror the Python `rabbitizer` extension
 * module (the rabbitizer/ directory C sources in the upstream repo). Every export is a thin call
 * into the library; argument checks and Python-shaped errors live in JS.
 *
 * An Instruction's struct words live in its JS object and are copied into a
 * static slot per call (see rab_instr_slot); a RegistersTracker is a malloc'd
 * RabbitizerRegistersTracker. Pointers are passed to JS as i32.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "rabbitizer.h"

#define EXPORT __attribute__((used, visibility("default")))

/* ------------------------------------------------------------------ */
/* Version                                                              */
/* ------------------------------------------------------------------ */

EXPORT int rab_version_major(void) { return RabVersion_Major; }
EXPORT int rab_version_minor(void) { return RabVersion_Minor; }
EXPORT int rab_version_patch(void) { return RabVersion_Patch; }
EXPORT const char *rab_version_str(void) { return RabVersion_Str; }
EXPORT const char *rab_version_author(void) { return RabVersion_Author; }

/* ------------------------------------------------------------------ */
/* Enum metadata, built with the same table includes and macros as the  */
/* Python binding sources in rabbitizer/enums/, so member names, order and */
/* values match that version exactly.                                   */
/* ------------------------------------------------------------------ */

typedef struct RabEnumEntry {
    const char *name;
    int value;
} RabEnumEntry;

#define RABBITIZER_DEF_ABI(name) { #name, RABBITIZER_ABI_##name },
static const RabEnumEntry enum_Abi[] = {
#include "tables/Abi.inc"
    RABBITIZER_DEF_ABI(MAX)
};
#undef RABBITIZER_DEF_ABI

#define RABBITIZER_DEF_INSTR_CATEGORY(name) { #name, RABBITIZER_INSTRCAT_##name },
static const RabEnumEntry enum_InstrCategory[] = {
#include "tables/InstrCategory.inc"
    RABBITIZER_DEF_INSTR_CATEGORY(MAX)
};
#undef RABBITIZER_DEF_INSTR_CATEGORY

#define RABBITIZER_DEF_INSTR_ID(prefix, caseBits, name, ...) { #prefix "_" #name, RABBITIZER_INSTR_ID_##prefix##_##name },
#define RABBITIZER_DEF_INSTR_ID_ALTNAME(prefix, caseBits, name, altname, ...) RABBITIZER_DEF_INSTR_ID(prefix, caseBits, name, __VA_ARGS__)
static const RabEnumEntry enum_InstrId[] = {
#include "tables/InstrIds.inc"
    RABBITIZER_DEF_INSTR_ID(ALL, , MAX, )
};
#undef RABBITIZER_DEF_INSTR_ID
#undef RABBITIZER_DEF_INSTR_ID_ALTNAME

#define RABBITIZER_DEF_INSTR_ID_TYPE(prefix, name) { #prefix "_" #name, RAB_INSTR_ID_TYPE_##prefix##_##name },
static const RabEnumEntry enum_InstrIdType[] = {
#include "tables/InstrIdType.inc"
};
#undef RABBITIZER_DEF_INSTR_ID_TYPE

#define RAB_DEF_OPERAND(prefix, operand) { #prefix "_" #operand, RAB_OPERAND_##prefix##_##operand },
static const RabEnumEntry enum_OperandType[] = {
    RAB_DEF_OPERAND(ALL, INVALID)
#include "tables/OperandTypes.inc"
    RAB_DEF_OPERAND(ALL, MAX)
};
#undef RAB_DEF_OPERAND

#define RAB_DEF_ACCESSTYPE(name) { #name, RAB_ACCESSTYPE_##name },
static const RabEnumEntry enum_AccessType[] = {
#include "tables/AccessType.inc"
    RAB_DEF_ACCESSTYPE(MAX)
};
#undef RAB_DEF_ACCESSTYPE

#define RABBITIZER_DEF_REG(prefix, name, numeric, ...) { #name, RABBITIZER_REG_##prefix##_##name },
#define RABBITIZER_DEF_REG_NODOLLAR(prefix, name, numeric, ...) RABBITIZER_DEF_REG(prefix, name, numeric)
static const RabEnumEntry enum_RegGprO32[] = {
#include "tables/registers/RabbitizerRegister_GprO32.inc"
};
static const RabEnumEntry enum_RegGprN32[] = {
#include "tables/registers/RabbitizerRegister_GprN32.inc"
};
static const RabEnumEntry enum_RegCop1O32[] = {
#include "tables/registers/RabbitizerRegister_Cop1O32.inc"
};
static const RabEnumEntry enum_RegCop1N32[] = {
#include "tables/registers/RabbitizerRegister_Cop1N32.inc"
};
static const RabEnumEntry enum_RegCop1N64[] = {
#include "tables/registers/RabbitizerRegister_Cop1N64.inc"
};
#undef RABBITIZER_DEF_REG
#undef RABBITIZER_DEF_REG_NODOLLAR

static const RabEnumEntry enum_TrinaryValue[] = {
    { "NONE", RAB_TRINARY_VAL_NONE },
    { "FALSE", RAB_TRINARY_VAL_FALSE },
    { "TRUE", RAB_TRINARY_VAL_TRUE },
};

#define ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))

typedef struct RabEnumTable {
    const char *typeName;
    const RabEnumEntry *entries;
    int count;
} RabEnumTable;

/* Same order as the Python module's attribute table. */
static const RabEnumTable enum_tables[] = {
    { "Abi", enum_Abi, ARRAY_LEN(enum_Abi) },
    { "InstrCategory", enum_InstrCategory, ARRAY_LEN(enum_InstrCategory) },
    { "InstrId", enum_InstrId, ARRAY_LEN(enum_InstrId) },
    { "InstrIdType", enum_InstrIdType, ARRAY_LEN(enum_InstrIdType) },
    { "OperandType", enum_OperandType, ARRAY_LEN(enum_OperandType) },
    { "AccessType", enum_AccessType, ARRAY_LEN(enum_AccessType) },
    { "RegGprO32", enum_RegGprO32, ARRAY_LEN(enum_RegGprO32) },
    { "RegGprN32", enum_RegGprN32, ARRAY_LEN(enum_RegGprN32) },
    { "RegCop1O32", enum_RegCop1O32, ARRAY_LEN(enum_RegCop1O32) },
    { "RegCop1N32", enum_RegCop1N32, ARRAY_LEN(enum_RegCop1N32) },
    { "RegCop1N64", enum_RegCop1N64, ARRAY_LEN(enum_RegCop1N64) },
    { "TrinaryValue", enum_TrinaryValue, ARRAY_LEN(enum_TrinaryValue) },
};

EXPORT int rab_enum_table_count(void) { return ARRAY_LEN(enum_tables); }
EXPORT const char *rab_enum_table_name(int t) { return enum_tables[t].typeName; }
EXPORT int rab_enum_count(int t) { return enum_tables[t].count; }
EXPORT const char *rab_enum_name(int t, int i) { return enum_tables[t].entries[i].name; }
EXPORT int rab_enum_value(int t, int i) { return enum_tables[t].entries[i].value; }

EXPORT int rab_abi_fromStr(const char *name) { return RabbitizerAbi_fromStr(name); }
EXPORT int rab_instrCategory_fromStr(const char *name) { return (int)RabbitizerInstrCategory_fromStr(name); }

/* ------------------------------------------------------------------ */
/* Global config (rabbitizer.config)                                    */
/* ------------------------------------------------------------------ */

/* Index order is mirrored by CONFIG_FIELDS in src/index.js. */
#define CONFIG_FIELDS(X) \
    X(0, regNames, namedRegisters) \
    X(1, regNames, gprAbiNames) \
    X(2, regNames, fprAbiNames) \
    X(3, regNames, userFpcCsr) \
    X(4, regNames, vr4300Cop0NamedRegisters) \
    X(5, regNames, vr4300RspCop0NamedRegisters) \
    X(6, regNames, r4000AllegrexVfpuControlNamedRegisters) \
    X(7, pseudos, enablePseudos) \
    X(8, pseudos, pseudoBeqz) \
    X(9, pseudos, pseudoBnez) \
    X(10, pseudos, pseudoB) \
    X(11, pseudos, pseudoMove) \
    X(12, pseudos, pseudoNot) \
    X(13, pseudos, pseudoNeg) \
    X(14, pseudos, pseudoNegu) \
    X(15, pseudos, pseudoBal) \
    X(16, toolchainTweaks, treatJAsUnconditionalBranch) \
    X(17, toolchainTweaks, sn64DivFix) \
    X(18, toolchainTweaks, gnuMode) \
    X(19, misc, opcodeLJust) \
    X(20, misc, unknownInstrComment) \
    X(21, misc, omit0XOnSmallImm) \
    X(22, misc, upperCaseImm) \
    X(23, misc, expandJalr)

EXPORT int rab_config_get(int field) {
    switch (field) {
#define X(i, cat, name) case i: return (int)RabbitizerConfig_Cfg.cat.name;
        CONFIG_FIELDS(X)
#undef X
    }
    return 0;
}

/* Bool fields are stored as bool (value != 0), the rest as their own type. */
EXPORT void rab_config_set(int field, int value) {
    switch (field) {
#define X(i, cat, name) \
    case i: RabbitizerConfig_Cfg.cat.name = _Generic(RabbitizerConfig_Cfg.cat.name, bool: value != 0, default: value); break;
        CONFIG_FIELDS(X)
#undef X
    }
}

/* ------------------------------------------------------------------ */
/* Instruction                                                          */
/* ------------------------------------------------------------------ */

/*
 * An Instruction is plain data (RabbitizerInstruction_destroy is a no-op in
 * every shipped version), so the JS object holds its own copy of the struct
 * words and copies them into one of these two slots for each call; nothing is
 * allocated per instruction on the WASM side. Two slots cover the calls that
 * take two instructions (sameOpcode, unsetRegistersAfterFuncCall, processLui).
 */
static RabbitizerInstruction instrSlots[2];

EXPORT RabbitizerInstruction *rab_instr_slot(int i) { return &instrSlots[i]; }
EXPORT int rab_instr_sizeof(void) { return (int)sizeof(RabbitizerInstruction); }
EXPORT int rab_instr_offsetof_word(void) { return (int)offsetof(RabbitizerInstruction, word); }
EXPORT int rab_instr_offsetof_uniqueId(void) { return (int)offsetof(RabbitizerInstruction, uniqueId); }
EXPORT int rab_instr_offsetof_vram(void) { return (int)offsetof(RabbitizerInstruction, vram); }

EXPORT void rab_instr_init(RabbitizerInstruction *self, uint32_t word, uint32_t vram, int category) {
    switch ((RabbitizerInstrCategory)category) {
        case RABBITIZER_INSTRCAT_RSP:
            RabbitizerInstructionRsp_init(self, word, vram);
            RabbitizerInstructionRsp_processUniqueId(self);
            break;

        case RABBITIZER_INSTRCAT_R3000GTE:
            RabbitizerInstructionR3000GTE_init(self, word, vram);
            RabbitizerInstructionR3000GTE_processUniqueId(self);
            break;

        case RABBITIZER_INSTRCAT_R5900:
            RabbitizerInstructionR5900_init(self, word, vram);
            RabbitizerInstructionR5900_processUniqueId(self);
            break;

        case RABBITIZER_INSTRCAT_R4000ALLEGREX:
            RabbitizerInstructionR4000Allegrex_init(self, word, vram);
            RabbitizerInstructionR4000Allegrex_processUniqueId(self);
            break;

        case RABBITIZER_INSTRCAT_CPU:
        case RABBITIZER_INSTRCAT_MAX:
        default:
            RabbitizerInstruction_init(self, word, vram);
            RabbitizerInstruction_processUniqueId(self);
            break;
    }
}

EXPORT uint32_t rab_instr_getVram(const RabbitizerInstruction *self) { return self->vram; }
EXPORT void rab_instr_setVram(RabbitizerInstruction *self, uint32_t vram) { self->vram = vram; }
EXPORT int rab_instr_getInHandwrittenFunction(const RabbitizerInstruction *self) { return self->inHandwrittenFunction; }
EXPORT void rab_instr_setInHandwrittenFunction(RabbitizerInstruction *self, int v) { self->inHandwrittenFunction = v != 0; }
EXPORT int rab_instr_getUniqueId(const RabbitizerInstruction *self) { return self->uniqueId; }
EXPORT int rab_instr_getInstrIdType(const RabbitizerInstruction *self) { return self->instrIdType; }
EXPORT int rab_instr_getCategory(const RabbitizerInstruction *self) { return self->category; }
EXPORT const char *rab_instr_getOpcodeName(const RabbitizerInstruction *self) { return RabbitizerInstrId_getOpcodeName(self->uniqueId); }

/* Register fields: -1 when the instruction does not have that operand (the
 * Python binding raises in that case; JS builds the message). */
#define REG_FIELD(name) \
    EXPORT int rab_instr_field_##name(const RabbitizerInstruction *self) { \
        if (!RabbitizerInstruction_hasOperandAlias(self, RAB_OPERAND_cpu_##name)) { \
            return -1; \
        } \
        return (int)RAB_INSTR_GET_##name(self); \
    }
REG_FIELD(rs)
REG_FIELD(rt)
REG_FIELD(rd)
REG_FIELD(fs)
REG_FIELD(ft)
REG_FIELD(fd)
#undef REG_FIELD

EXPORT uint32_t rab_instr_field_sa(const RabbitizerInstruction *self) { return RAB_INSTR_GET_sa(self); }

EXPORT int rab_instr_getFlag(const RabbitizerInstruction *self, int which) {
    switch (which) {
        case 0: return RAB_INSTR_FLAGS_GET_r5900DisasmAsData(self);
        case 1: return RAB_INSTR_FLAGS_GET_r5900UseDollar(self);
#ifdef RAB_INSTR_FLAGS_GET_r5900ProdgSnAsInvertedRegs
        case 2: return RAB_INSTR_FLAGS_GET_r5900ProdgSnAsInvertedRegs(self);
#endif
    }
    return 0;
}

EXPORT void rab_instr_setFlag(RabbitizerInstruction *self, int which, int value) {
    switch (which) {
        case 0: RAB_INSTR_FLAGS_SET_r5900DisasmAsData(self, value); break;
        case 1: RAB_INSTR_FLAGS_SET_r5900UseDollar(self, value); break;
#ifdef RAB_INSTR_FLAGS_SET_r5900ProdgSnAsInvertedRegs
        case 2: RAB_INSTR_FLAGS_SET_r5900ProdgSnAsInvertedRegs(self, value); break;
#endif
    }
}

EXPORT int rab_has_flag_r5900ProdgSnAsInvertedRegs(void) {
#ifdef RAB_INSTR_FLAGS_GET_r5900ProdgSnAsInvertedRegs
    return 1;
#else
    return 0;
#endif
}

EXPORT uint32_t rab_instr_getRaw(const RabbitizerInstruction *self) { return RabbitizerInstruction_getRaw(self); }

EXPORT int rab_instr_hasImmediate(const RabbitizerInstruction *self) {
    return RabbitizerInstruction_hasOperandAlias(self, RAB_OPERAND_cpu_immediate);
}
EXPORT uint32_t rab_instr_getImmediate(const RabbitizerInstruction *self) { return RAB_INSTR_GET_immediate(self); }
EXPORT int32_t rab_instr_getProcessedImmediate(const RabbitizerInstruction *self) {
    return RabbitizerInstruction_getProcessedImmediate(self);
}

EXPORT int rab_instr_hasLabel(const RabbitizerInstruction *self) {
    return RabbitizerInstruction_hasOperandAlias(self, RAB_OPERAND_cpu_label);
}
EXPORT int rab_instr_hasBranchTargetLabel(const RabbitizerInstruction *self) {
    return RabbitizerInstruction_hasOperand(self, RAB_OPERAND_cpu_branch_target_label);
}
EXPORT uint32_t rab_instr_getInstrIndexAsVram(const RabbitizerInstruction *self) {
    return RabbitizerInstruction_getInstrIndexAsVram(self);
}
EXPORT int32_t rab_instr_getBranchOffset(const RabbitizerInstruction *self) {
    return RabbitizerInstruction_getBranchOffset(self);
}
EXPORT int32_t rab_instr_getGenericBranchOffset(const RabbitizerInstruction *self, uint32_t currentVram) {
    return RabbitizerInstruction_getGenericBranchOffset(self, currentVram);
}
EXPORT int32_t rab_instr_getBranchOffsetGeneric(const RabbitizerInstruction *self) {
    return RabbitizerInstruction_getBranchOffsetGeneric(self);
}
EXPORT uint32_t rab_instr_getBranchVramGeneric(const RabbitizerInstruction *self) {
    return RabbitizerInstruction_getBranchVramGeneric(self);
}
EXPORT int rab_instr_getDestinationGpr(const RabbitizerInstruction *self) {
    return RabbitizerInstruction_getDestinationGpr(self);
}
EXPORT void rab_instr_blankOut(RabbitizerInstruction *self) { RabbitizerInstruction_blankOut(self); }
EXPORT const char *rab_instr_mapInstrToType(const RabbitizerInstruction *self) {
    return RabbitizerInstruction_mapInstrToType(self);
}
EXPORT int rab_instr_sameOpcode(const RabbitizerInstruction *self, const RabbitizerInstruction *other) {
    return RabbitizerInstruction_sameOpcode(self, other);
}
EXPORT int rab_instr_sameOpcodeButDifferentArguments(const RabbitizerInstruction *self, const RabbitizerInstruction *other) {
    return RabbitizerInstruction_sameOpcodeButDifferentArguments(self, other);
}
EXPORT int rab_instr_hasOperand(const RabbitizerInstruction *self, int operand) {
    return RabbitizerInstruction_hasOperand(self, (RabbitizerOperandType)operand);
}
EXPORT int rab_instr_hasOperandAlias(const RabbitizerInstruction *self, int operand) {
    return RabbitizerInstruction_hasOperandAlias(self, (RabbitizerOperandType)operand);
}
EXPORT int rab_instr_getAccessType(const RabbitizerInstruction *self) {
    return RabbitizerInstrDescriptor_getAccessType(self->descriptor);
}

/* Instruction-level predicates (RabbitizerInstruction_<name>). */
#define INSTR_BOOL(name) \
    EXPORT int rab_ib_##name(const RabbitizerInstruction *self) { return RabbitizerInstruction_##name(self); }
INSTR_BOOL(outputsToGprZero)
INSTR_BOOL(isImplemented)
INSTR_BOOL(isLikelyHandwritten)
INSTR_BOOL(isNop)
INSTR_BOOL(isUnconditionalBranch)
INSTR_BOOL(isFunctionCall)
INSTR_BOOL(isReturn)
INSTR_BOOL(isJumptableJump)
INSTR_BOOL(isJrRa)
INSTR_BOOL(isJrNotRa)
INSTR_BOOL(hasDelaySlot)
INSTR_BOOL(isValid)
#undef INSTR_BOOL

/* Descriptor-level predicates (RabbitizerInstrDescriptor_<name>). */
#define DESC_BOOL(name) \
    EXPORT int rab_db_##name(const RabbitizerInstruction *self) { return RabbitizerInstrDescriptor_##name(self->descriptor); }
DESC_BOOL(isUnknownType)
DESC_BOOL(isJType)
DESC_BOOL(isIType)
DESC_BOOL(isRType)
DESC_BOOL(isRegimmType)
DESC_BOOL(isBranch)
DESC_BOOL(isBranchLikely)
DESC_BOOL(isJump)
DESC_BOOL(isJumpWithAddress)
DESC_BOOL(isTrap)
DESC_BOOL(isFloat)
DESC_BOOL(isDouble)
DESC_BOOL(isUnsigned)
DESC_BOOL(modifiesRs)
DESC_BOOL(modifiesRt)
DESC_BOOL(modifiesRd)
DESC_BOOL(readsRs)
DESC_BOOL(readsRt)
DESC_BOOL(readsRd)
DESC_BOOL(readsHI)
DESC_BOOL(readsLO)
DESC_BOOL(modifiesHI)
DESC_BOOL(modifiesLO)
DESC_BOOL(modifiesFs)
DESC_BOOL(modifiesFt)
DESC_BOOL(modifiesFd)
DESC_BOOL(readsFs)
DESC_BOOL(readsFt)
DESC_BOOL(readsFd)
DESC_BOOL(notEmitedByCompilers)
DESC_BOOL(notEmittedByCompilers)
DESC_BOOL(canBeHi)
DESC_BOOL(canBeLo)
DESC_BOOL(doesLink)
DESC_BOOL(doesDereference)
DESC_BOOL(doesLoad)
DESC_BOOL(doesStore)
DESC_BOOL(maybeIsMove)
DESC_BOOL(isPseudo)
DESC_BOOL(doesUnsignedMemoryAccess)
#undef DESC_BOOL

/*
 * Disassembles into dst (capacity dstCap bytes, including the terminator).
 * Returns the string length, or -(needed capacity) when dst is too small, in
 * which case nothing is written and the caller retries with a bigger buffer.
 * Returns INT32_MIN when the library wrote more than it asked for (the Python
 * binding raises AssertionError in that case).
 */
EXPORT int32_t rab_instr_disassemble(const RabbitizerInstruction *self, char *dst, int32_t dstCap,
                                     const char *immOverride, int32_t immOverrideLength, int extraLJust) {
    size_t bufferSize = RabbitizerInstruction_getSizeForBuffer(self, (size_t)immOverrideLength, extraLJust);
    size_t written;

    if (bufferSize + 1 > (size_t)dstCap) {
        return -(int32_t)(bufferSize + 1);
    }
    written = RabbitizerInstruction_disassemble(self, dst, immOverride, (size_t)immOverrideLength, extraLJust);
    if (written > bufferSize) {
        return INT32_MIN;
    }
    return (int32_t)strlen(dst);
}

/* ------------------------------------------------------------------ */
/* RegistersTracker                                                     */
/* ------------------------------------------------------------------ */

EXPORT RabbitizerRegistersTracker *rab_tracker_new(const RabbitizerRegistersTracker *other) {
    RabbitizerRegistersTracker *self = malloc(sizeof(RabbitizerRegistersTracker));

    if (self == NULL) {
        return NULL;
    }
    RabbitizerRegistersTracker_init(self, other);
    return self;
}

EXPORT void rab_tracker_free(RabbitizerRegistersTracker *self) {
    RabbitizerRegistersTracker_destroy(self);
    free(self);
}

EXPORT int rab_tracker_register_count(void) { return ARRAY_LEN(((RabbitizerRegistersTracker *)0)->registers); }

/* Out-parameters are written to this static scratch struct and read by JS. */
static struct {
    int32_t i0;
    uint32_t u0;
    int32_t b0;
    int32_t b1;
} out;

EXPORT void *rab_out_ptr(void) { return &out; }

EXPORT int rab_tracker_moveRegisters(RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr) {
    return RabbitizerRegistersTracker_moveRegisters(self, instr);
}
EXPORT void rab_tracker_overwriteRegisters(RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr, int instrOffset) {
    RabbitizerRegistersTracker_overwriteRegisters(self, instr, instrOffset);
}
EXPORT void rab_tracker_unsetRegistersAfterFuncCall(RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr,
                                                     const RabbitizerInstruction *prevInstr) {
    RabbitizerRegistersTracker_unsetRegistersAfterFuncCall(self, instr, prevInstr);
}
EXPORT int rab_tracker_getAddressIfCanSetType(const RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr,
                                              int instrOffset) {
    uint32_t dstAddress = 0;
    bool ok = RabbitizerRegistersTracker_getAddressIfCanSetType(self, instr, instrOffset, &dstAddress);

    out.u0 = dstAddress;
    return ok;
}
EXPORT int rab_tracker_getJrInfo(const RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr) {
    int dstOffset = 0;
    uint32_t dstAddress = 0;
    bool ok = RabbitizerRegistersTracker_getJrInfo(self, instr, &dstOffset, &dstAddress);

    out.i0 = dstOffset;
    out.u0 = dstAddress;
    return ok;
}

static RabbitizerJrRegData jrRegDataOut;
EXPORT void rab_tracker_getJrRegData(const RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr) {
    jrRegDataOut = RabbitizerRegistersTracker_getJrRegData(self, instr);
}
EXPORT void rab_jrRegData_init(void) { RabbitizerJrRegData_init(&jrRegDataOut); }
EXPORT int rab_jrRegData_hasInfo(void) { return jrRegDataOut.hasInfo; }
EXPORT int rab_jrRegData_offset(void) { return jrRegDataOut.offset; }
EXPORT uint32_t rab_jrRegData_address(void) { return jrRegDataOut.address; }
EXPORT int rab_jrRegData_checkedForBranching(void) { return jrRegDataOut.checkedForBranching; }
EXPORT int rab_jrRegData_lastBranchOffset(void) { return jrRegDataOut.lastBranchOffset; }

EXPORT void rab_tracker_processLui(RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr, int instrOffset,
                                   const RabbitizerInstruction *prevInstr) {
    RabbitizerRegistersTracker_processLui(self, instr, instrOffset, prevInstr);
}
EXPORT void rab_tracker_processGpLoad(RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr, int instrOffset) {
    RabbitizerRegistersTracker_processGpLoad(self, instr, instrOffset);
}
EXPORT int rab_tracker_getLuiOffsetForConstant(const RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr) {
    int dstOffset = 0;
    bool ok = RabbitizerRegistersTracker_getLuiOffsetForConstant(self, instr, &dstOffset);

    out.i0 = dstOffset;
    return ok;
}
EXPORT void rab_tracker_processConstant(RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr, uint32_t value,
                                        int instrOffset) {
    RabbitizerRegistersTracker_processConstant(self, instr, value, instrOffset);
}
EXPORT int rab_tracker_getLuiOffsetForLo(RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr, int instrOffset) {
    int dstOffset = 0;
    bool dstIsGp = false;
    bool ok = RabbitizerRegistersTracker_getLuiOffsetForLo(self, instr, instrOffset, &dstOffset, &dstIsGp);

    out.i0 = dstOffset;
    out.b0 = dstIsGp;
    return ok;
}

static RabbitizerLoPairingInfo loPairingOut;
EXPORT void rab_tracker_preprocessLoAndGetInfo(RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr,
                                               int instrOffset) {
    loPairingOut = RabbitizerRegistersTracker_preprocessLoAndGetInfo(self, instr, instrOffset);
}
EXPORT void rab_loPairing_init(void) { RabbitizerLoPairingInfo_Init(&loPairingOut); }
EXPORT int rab_loPairing_instrOffset(void) { return loPairingOut.instrOffset; }
/* value is int64_t; returned as two halves so no BigInt crosses the boundary. */
EXPORT uint32_t rab_loPairing_valueLo(void) { return (uint32_t)(uint64_t)loPairingOut.value; }
EXPORT int32_t rab_loPairing_valueHi(void) { return (int32_t)(loPairingOut.value >> 32); }
EXPORT int rab_loPairing_shouldProcess(void) { return loPairingOut.shouldProcess; }
EXPORT int rab_loPairing_isGpRel(void) { return loPairingOut.isGpRel; }
EXPORT int rab_loPairing_isGpGot(void) { return loPairingOut.isGpGot; }

EXPORT void rab_tracker_processLo(RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr, uint32_t value,
                                  int instrOffset) {
    RabbitizerRegistersTracker_processLo(self, instr, value, instrOffset);
}
EXPORT void rab_tracker_processBranch(RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr, int instrOffset) {
    RabbitizerRegistersTracker_processBranch(self, instr, instrOffset);
}
EXPORT int rab_tracker_hasLoButNoHi(const RabbitizerRegistersTracker *self, const RabbitizerInstruction *instr) {
    return RabbitizerRegistersTracker_hasLoButNoHi(self, instr);
}

/* ------------------------------------------------------------------ */
/* TrackedRegisterState                                                 */
/* ------------------------------------------------------------------ */

static RabbitizerTrackedRegisterState stateOut;

/* TrackedRegisterState(registerNum) */
EXPORT void rab_state_init(int registerNum) {
    RabbitizerTrackedRegisterState_init(&stateOut, registerNum);
}

/* RegistersTracker.__getitem__: a new state for the register number, then a
 * copy of the tracked state, as the Python binding does. */
EXPORT void rab_state_fromTracker(const RabbitizerRegistersTracker *tracker, int index) {
    const RabbitizerTrackedRegisterState *state = &tracker->registers[index];

    RabbitizerTrackedRegisterState_init(&stateOut, state->registerNum);
    RabbitizerTrackedRegisterState_copyState(&stateOut, state);
}

/* Field order mirrored by STATE_FIELDS in src/index.js. */
EXPORT uint32_t rab_state_field(int field) {
    switch (field) {
        case 0: return (uint32_t)stateOut.registerNum;
        case 1: return stateOut.hasLuiValue;
        case 2: return (uint32_t)stateOut.luiOffset;
        case 3: return stateOut.luiSetOnBranchLikely;
        case 4: return stateOut.hasGpGot;
        case 5: return (uint32_t)stateOut.gpGotOffset;
        case 6: return stateOut.hasLoValue;
        case 7: return (uint32_t)stateOut.loOffset;
        case 8: return stateOut.dereferenced;
        case 9: return (uint32_t)stateOut.dereferenceOffset;
        case 10: return stateOut.checkedForBranching;
        case 11: return (uint32_t)stateOut.lastBranchOffset;
        case 12: return stateOut.value;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Utils                                                                */
/* ------------------------------------------------------------------ */

EXPORT int32_t rab_utils_from2Complement(uint32_t number, int bits) {
    return RabbitizerUtils_From2Complement(number, bits);
}
EXPORT uint32_t rab_utils_escapeString(char *dst, uint32_t dstSize, const char *src, uint32_t srcSize) {
    return (uint32_t)RabbitizerUtils_escapeString(dst, dstSize, src, srcSize);
}
EXPORT uint32_t rab_utils_floatRepr_32From16(uint32_t hexRepr) {
    return RabbitizerUtils_floatRepr_32From16((uint16_t)hexRepr);
}

EXPORT void *rab_malloc(uint32_t size) { return malloc(size); }
EXPORT void rab_free(void *p) { free(p); }
