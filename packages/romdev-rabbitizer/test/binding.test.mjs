// romdev-rabbitizer binding tests. No ROM needed: the disassembly strings are
// upstream rabbitizer's own expected outputs (tests/python/disasm_test.py and
// tests/c/instruction_checks/plain_disassembly.c, MIT, Decompollaborate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSIONS, DEFAULT_VERSION, loadRabbitizer, loadRabbitizerSync } from "../src/index.js";

// wasm/ is gitignored: a dev box builds it (packages/romdevtools/scripts/
// build-rabbitizer.sh) and CI fills it from the published npm tarball
// (scripts/fetch-payloads.mjs). Without it every test skips with this reason
// instead of failing on ENOENT, the contract romdevtools' test-rom.js set.
const absent = VERSIONS.map((v) => `wasm/rabbitizer-${v}.wasm`).filter((f) => !existsSync(fileURLToPath(new URL(`../${f}`, import.meta.url))));
const WASM_SKIP = absent.length ? `romdev-rabbitizer payload absent (${absent.join(", ")}): gitignored WASM, built by packages/romdevtools/scripts/build-rabbitizer.sh or filled from npm by scripts/fetch-payloads.mjs` : false;
const r1162 = WASM_SKIP ? null : await import("romdev-rabbitizer/1.16.2");

// [word, immOverride, expected] with default config and gnuMode on.
const PLAIN = [
  [0x3C088001, null, "lui         $t0, 0x8001"],
  [0x25080E60, null, "addiu       $t0, $t0, 0xE60"],
  [0x3C090002, null, "lui         $t1, 0x2"],
  [0x25298DE0, null, "addiu       $t1, $t1, -0x7220"],
  [0xAD000000, null, "sw          $zero, 0x0($t0)"],
  [0xAD000004, null, "sw          $zero, 0x4($t0)"],
  [0x21080008, null, "addi        $t0, $t0, 0x8"],
  [0x2129FFF8, null, "addi        $t1, $t1, -0x8"],
  [0x1520FFFB, null, "bnez        $t1, . + 4 + (-0x5 << 2)"],
  [0x00000000, null, "nop"],
  [0x3C0A8000, null, "lui         $t2, 0x8000"],
  [0x254A0494, null, "addiu       $t2, $t2, 0x494"],
  [0x3C1D8002, null, "lui         $sp, 0x8002"],
  [0x01400008, null, "jr          $t2"],
  [0x27BDF8C0, null, "addiu       $sp, $sp, -0x740"],
  [0x3C018001, null, "lui         $at, 0x8001"],
  [0x03E00008, null, "jr          $ra"],
  [0xAC24E190, null, "sw          $a0, -0x1E70($at)"],
  [0x3C018001, "%hi(D_8000E190)", "lui         $at, %hi(D_8000E190)"],
  [0xAC24E190, "%lo(D_8000E190)", "sw          $a0, %lo(D_8000E190)($at)"],
  [0x0C001F24, null, "jal         func_80007C90"],
  [0x0C001F24, "some_func", "jal         some_func"],
  [0x8F99805C, null, "lw          $t9, -0x7FA4($gp)"],
  [0x8F99805C, "%call16(strcmp)", "lw          $t9, %call16(strcmp)($gp)"],
  [0x8F858028, null, "lw          $a1, -0x7FD8($gp)"],
  [0x8F858028, "%got(STR_10007C90)", "lw          $a1, %got(STR_10007C90)($gp)"],
  [0x00435022, null, "sub         $t2, $v0, $v1"],
  [0x00025022, null, "neg         $t2, $v0"],
  [0x00E41823, null, "subu        $v1, $a3, $a0"],
  [0x00041823, null, "negu        $v1, $a0"],
  [0x42000010, null, "rfe"],
  [0x44444444, null, ".word       0x44444444                   # cfc1        $a0, $8 # 00000444 <InstrIdType: CPU_COP1>"],
  [0x77777777, null, ".word       0x77777777                   # INVALID     $k1, $s7, 0x7777 # 00000000 <InstrIdType: CPU_NORMAL>"],
  [0xEEEEEEEE, null, ".word       0xEEEEEEEE                   # INVALID     $s7, $t6, -0x1112 # 00000000 <InstrIdType: CPU_NORMAL>"],
];

const CONFIG_DEFAULTS = {
  regNames_namedRegisters: true,
  regNames_userFpcCsr: true,
  regNames_vr4300Cop0NamedRegisters: true,
  regNames_vr4300RspCop0NamedRegisters: true,
  regNames_r4000AllegrexVfpuControlNamedRegisters: false,
  pseudos_enablePseudos: true,
  pseudos_pseudoBeqz: true,
  pseudos_pseudoBnez: true,
  pseudos_pseudoB: true,
  pseudos_pseudoMove: true,
  pseudos_pseudoNot: true,
  pseudos_pseudoNeg: true,
  pseudos_pseudoNegu: true,
  pseudos_pseudoBal: true,
  toolchainTweaks_treatJAsUnconditionalBranch: true,
  toolchainTweaks_sn64DivFix: false,
  toolchainTweaks_gnuMode: true,
  misc_opcodeLJust: 11,
  misc_unknownInstrComment: true,
  misc_omit0XOnSmallImm: false,
  misc_upperCaseImm: true,
  misc_expandJalr: false,
};

// Runs fn with config fields temporarily set, restoring them afterwards.
function withConfig(rab, fields, fn) {
  const saved = {};
  for (const k of Object.keys(fields)) saved[k] = rab.config[k];
  try {
    Object.assign(rab.config, fields);
    return fn();
  } finally {
    Object.assign(rab.config, saved);
  }
}

test("loader: every shipped version loads, reports its version, defaults to the newest", { skip: WASM_SKIP }, async () => {
  assert.deepEqual(VERSIONS, ["1.16.2", "1.14.3", "1.13.0"]);
  assert.equal(DEFAULT_VERSION, "1.16.2");
  for (const v of VERSIONS) {
    const rab = loadRabbitizerSync(v);
    assert.equal(rab.__version__, v);
    assert.deepEqual([...rab.__version_info__], v.split(".").map(Number));
    assert.equal(rab.__author__, "Decompollaborate");
    assert.equal(await loadRabbitizer(v), rab, "one shared namespace per version");
  }
  assert.equal(await loadRabbitizer(), loadRabbitizerSync("1.16.2"));
  assert.equal(r1162.default, loadRabbitizerSync("1.16.2"));
  assert.equal(r1162.Instruction, loadRabbitizerSync("1.16.2").Instruction);
  assert.throws(() => loadRabbitizerSync("0.0.1"), /unknown rabbitizer version/);
});

for (const v of VERSIONS) {
  test(`${v}: upstream expected disassembly (plain CPU)`, { skip: WASM_SKIP }, () => {
    const rab = loadRabbitizerSync(v);
    for (const [word, imm, expected] of PLAIN) {
      const instr = new rab.Instruction(word);
      assert.equal(instr.disassemble(imm), expected, `word 0x${word.toString(16)}`);
      if (imm === null) assert.equal(String(instr), expected);
    }
  });

  test(`${v}: config defaults, setters change the output, unknown fields are rejected`, { skip: WASM_SKIP }, () => {
    const rab = loadRabbitizerSync(v);
    for (const [k, want] of Object.entries(CONFIG_DEFAULTS)) assert.equal(rab.config[k], want, k);
    assert.equal(rab.config.regNames_gprAbiNames, rab.Abi.O32);
    assert.equal(rab.config.regNames_fprAbiNames, rab.Abi.NUMERIC);

    const addiu = new rab.Instruction(0x27BDFFE8);
    withConfig(rab, { misc_opcodeLJust: 10 }, () => assert.equal(addiu.disassemble(), "addiu      $sp, $sp, -0x18"));
    assert.equal(addiu.disassemble(null, -1), "addiu      $sp, $sp, -0x18");
    withConfig(rab, { regNames_namedRegisters: false }, () => assert.equal(addiu.disassemble(), "addiu       $29, $29, -0x18"));
    withConfig(rab, { regNames_gprAbiNames: rab.Abi.N32 }, () => {
      assert.equal(addiu.rs, rab.RegGprN32.sp);
      assert.equal(new rab.Instruction(0x3C088001).rt, rab.RegGprN32.a4);
    });
    // Pseudo-instruction selection happens when the word is decoded.
    assert.equal(new rab.Instruction(0x00801025).disassemble(), "move        $v0, $a0");
    withConfig(rab, { pseudos_pseudoMove: false }, () => {
      assert.equal(new rab.Instruction(0x00801025).disassemble(), "or          $v0, $a0, $zero");
    });

    assert.throws(() => { rab.config.regNames_gprAbiNames = rab.InstrCategory.CPU; }, { name: "ValueError" });
    assert.throws(() => { rab.config.regNames_gprAbiNames = "o32"; }, TypeError);
    assert.throws(() => { rab.config.misc_opcodeLJust = "11"; }, TypeError);
    assert.throws(() => { rab.config.noSuchField = true; }, TypeError);
    assert.equal(rab.config.misc_opcodeLJust, 11);
  });

  test(`${v}: enums are shared singletons with Python names and values`, { skip: WASM_SKIP }, () => {
    const rab = loadRabbitizerSync(v);
    const a = new rab.Instruction(0x27BDFFE8);
    const b = new rab.Instruction(0x27A40010);
    assert.equal(a.uniqueId, rab.InstrId.cpu_addiu);
    assert.equal(a.uniqueId, b.uniqueId);
    assert.ok(a.uniqueId instanceof rab.Enum);
    assert.equal(a.uniqueId.name, "cpu_addiu");
    assert.equal(typeof a.uniqueId.value, "number");
    assert.equal(String(a.uniqueId), `<InstrId: cpu_addiu (${a.uniqueId.value})>`);
    const map = new Map([[rab.InstrId.cpu_addiu, "x"]]);
    assert.equal(map.get(b.uniqueId), "x");
    assert.equal(a.rs, rab.RegGprO32.sp);
    assert.equal(b.rt, rab.RegGprO32.a0);
    assert.equal(a.instrIdType, rab.InstrIdType.CPU_NORMAL);
    assert.equal(a.getAccessType(), rab.AccessType.INVALID);
    assert.equal(new rab.Instruction(0x8FBF0014).getAccessType(), rab.AccessType.WORD);
    assert.equal(rab.Abi.fromStr("n32"), rab.Abi.N32);
    assert.equal(rab.Abi.fromStr(null), rab.Abi.O32);
    assert.equal(rab.Abi.fromStr("numeric"), rab.Abi.NUMERIC);
    assert.equal(rab.InstrCategory.fromStr("R5900"), rab.InstrCategory.R5900);
    assert.equal(rab.InstrCategory.fromStr("bogus"), null);
    assert.equal(rab.InstrCategory.fromStr(null), null);
    // Identity equals Python's (type, value) equality: no two members of one
    // enum type share a value, apart from InstrId's two MAX sentinels.
    for (const type of ["Abi", "InstrCategory", "InstrId", "InstrIdType", "OperandType", "AccessType",
      "RegGprO32", "RegGprN32", "RegCop1O32", "RegCop1N32", "RegCop1N64", "TrinaryValue"]) {
      const seen = new Map();
      for (const m of Object.values(rab[type])) {
        if (!(m instanceof rab.Enum)) continue;
        assert.equal(m.enumType, type);
        if (seen.has(m.value)) assert.deepEqual([type, [seen.get(m.value), m.name].sort()], ["InstrId", ["ALL_MAX", "r5900_MAX"]]);
        seen.set(m.value, m.name);
      }
      assert.ok(seen.size > 1, type);
    }
  });

  test(`${v}: Instruction methods and Python-shaped errors`, { skip: WASM_SKIP }, () => {
    const rab = loadRabbitizerSync(v);
    const lui = new rab.Instruction(0x3C088001, 0x80000400);
    assert.equal(lui.getRaw(), 0x3C088001);
    assert.equal(lui.vram, 0x80000400);
    lui.vram = 0x80001000;
    assert.equal(lui.vram, 0x80001000);
    assert.equal(lui.getImmediate(), 0x8001);
    assert.equal(lui.getProcessedImmediate(), 0x8001);
    assert.equal(lui.getOpcodeName(), "lui");
    assert.equal(lui.canBeHi(), true);
    assert.equal(lui.getDestinationGpr(), rab.RegGprO32.t0);
    assert.equal(lui.hasOperandAlias(rab.OperandType.cpu_immediate), true);
    assert.equal(lui.hasOperand(rab.OperandType.cpu_rs), false);
    assert.throws(() => lui.rs, { name: "RuntimeError", message: "'lui' instruction does not reference register 'rs'" });
    assert.throws(() => lui.getBranchOffset(), { name: "RuntimeError", message: "'lui' instruction does not have an 'branch label' field" });
    assert.throws(() => lui.getInstrIndexAsVram(), { name: "RuntimeError", message: "'lui' instruction does not have an 'jump label' field" });
    assert.throws(() => lui.getBranchVramGeneric(), { name: "RuntimeError", message: "'lui' instruction does not not perform a branch or a jump." });
    assert.throws(() => lui.hasOperand(rab.InstrId.cpu_nop), { name: "ValueError" });
    assert.throws(() => lui.hasOperand(3), TypeError);
    assert.throws(() => new rab.Instruction(0, 0, rab.Abi.O32), { name: "ValueError" });
    assert.throws(() => new rab.Instruction("x"), TypeError);
    assert.throws(() => lui.disassemble(5), TypeError);

    const addu = new rab.Instruction(0x00851021); // addu $v0, $a0, $a1
    assert.throws(() => addu.getProcessedImmediate(), { name: "RuntimeError", message: "'addu' instruction does not have an 'immediate' field" });
    assert.equal(addu.modifiesRd(), true);
    assert.equal(addu.readsRs(), true);
    assert.equal(addu.sameOpcode(new rab.Instruction(0x00A41821)), true);
    assert.equal(addu.sameOpcodeButDifferentArguments(new rab.Instruction(0x00A41821)), true);
    assert.throws(() => addu.sameOpcode({}), TypeError);

    const sw = new rab.Instruction(0xAFBF0014);
    assert.equal(sw.getDestinationGpr(), null);
    assert.equal(sw.doesStore(), true);
    assert.equal(sw.getProcessedImmediate(), 0x14);
    assert.equal(new rab.Instruction(0x2129FFF8).getProcessedImmediate(), -8);

    const bnez = new rab.Instruction(0x1520FFFB, 0x80000420); // bnez $t1, -0x5 words
    assert.equal(bnez.isBranch(), true);
    assert.equal(bnez.hasDelaySlot(), true);
    assert.equal(bnez.getBranchOffset(), -0x10);
    assert.equal(bnez.getBranchOffsetGeneric(), -0x10);
    assert.equal(bnez.getBranchVramGeneric(), 0x80000410);
    assert.equal(bnez.getGenericBranchOffset(0x80000420), -0x10);

    const jal = new rab.Instruction(0x0C001F24, 0x80000400);
    assert.equal(jal.isFunctionCall(), true);
    assert.equal(jal.doesLink(), true);
    assert.equal(jal.getInstrIndexAsVram(), 0x80007C90);
    assert.equal(jal.getBranchVramGeneric(), 0x80007C90);

    const jr = new rab.Instruction(0x03E00008);
    assert.equal(jr.isReturn(), true);
    assert.equal(jr.isJrRa(), true);
    assert.equal(new rab.Instruction(0x01400008).isJumptableJump(), true);
    assert.equal(new rab.Instruction(0).isNop(), true);
    assert.equal(new rab.Instruction(0).isValid(), true);
    assert.equal(new rab.Instruction(0x77777777).isValid(), false);

    const fadd = new rab.Instruction(0x46062100); // add.s $f4, $f4, $f6
    assert.equal(fadd.fd, rab.RegCop1O32.ft0);
    withConfig(rab, { regNames_fprAbiNames: rab.Abi.NUMERIC }, () => {
      assert.equal(fadd.fd.enumType, "RegCop1O32");
      assert.equal(fadd.disassemble(), "add.s       $f4, $f4, $f6");
    });
    assert.equal(fadd.isFloat(), true);

    assert.equal(lui.inHandwrittenFunction, false);
    lui.inHandwrittenFunction = true;
    assert.equal(lui.inHandwrittenFunction, true);
    assert.throws(() => { lui.inHandwrittenFunction = 1; }, TypeError);

    assert.equal(lui.flag_r5900DisasmAsData, rab.TrinaryValue.NONE);
    lui.flag_r5900UseDollar = rab.TrinaryValue.TRUE;
    assert.equal(lui.flag_r5900UseDollar, rab.TrinaryValue.TRUE);
    assert.throws(() => { lui.flag_r5900UseDollar = rab.Abi.O32; }, { name: "ValueError" });
    assert.equal("flag_r5900ProdgSnAsInvertedRegs" in lui, v === "1.16.2");

    const cat = new rab.Instruction(0x4A180001, 0, rab.InstrCategory.R3000GTE);
    assert.equal(cat.getOpcodeName().toLowerCase(), "rtps");

    const blank = new rab.Instruction(0x27BDFFE8);
    blank.blankOut();
    assert.equal(blank.getRaw() & 0xFC000000, 0x24000000);
    assert.equal(blank.uniqueId, rab.InstrId.cpu_addiu);
  });

  test(`${v}: RegistersTracker pairs a lui with its lo`, { skip: WASM_SKIP }, () => {
    const rab = loadRabbitizerSync(v);
    const lui = new rab.Instruction(0x3C018001, 0x80000400); // lui $at, 0x8001
    const lo = new rab.Instruction(0x2424E190, 0x80000404); //  addiu $a0, $at, -0x1E70
    const lw = new rab.Instruction(0x8C820000, 0x80000408); //  lw $v0, 0x0($a0)
    const tracker = new rab.RegistersTracker();
    assert.equal(tracker.__getitem__(1).hasLuiValue, false);
    tracker.processLui(lui, 0x0);
    const st = tracker.getItem(1);
    assert.equal(st.registerNum, 1);
    assert.equal(st.hasLuiValue, true);
    assert.equal(st.luiOffset, 0);
    assert.equal(st.value, 0x80010000);
    assert.throws(() => { st.value = 1; }, TypeError);
    assert.throws(() => tracker.__getitem__(32), { name: "IndexError", message: "Index must be a value between 0 and 31" });

    const info = tracker.preprocessLoAndGetInfo(lo, 0x4);
    assert.ok(info instanceof rab.LoPairingInfo);
    assert.equal(info.shouldProcess, true);
    assert.equal(info.instrOffset, 0);
    assert.equal(info.value, 0x80010000);
    assert.equal(info.isGpRel, false);
    assert.deepEqual(tracker.getLuiOffsetForLo(lo, 0x4), [0, false, true]);
    assert.equal(tracker.getAddressIfCanSetType(lw, 0x8), null);
    tracker.processLo(lo, 0x8000E190, 0x4);
    assert.equal(tracker.getItem(4).hasLoValue, true);
    assert.equal(tracker.getItem(4).value, 0x8000E190);
    assert.equal(tracker.hasLoButNoHi(lo), false);
    assert.equal(tracker.getAddressIfCanSetType(lw, 0x8), 0x8000E190);

    const copy = new rab.RegistersTracker(tracker);
    assert.equal(copy.getItem(4).hasLoValue, true);
    assert.equal(copy.getItem(4).value, 0x8000E190);
    assert.throws(() => new rab.RegistersTracker({}), TypeError);

    const jr = new rab.Instruction(0x00200008); // jr $at
    const jrData = tracker.getJrRegData(jr);
    assert.ok(jrData instanceof rab.JrRegData);
    assert.equal(typeof jrData.hasInfo(), "boolean");
    const info2 = tracker.getJrInfo(jr);
    assert.ok(info2 === null || (Array.isArray(info2) && info2.length === 2));
    assert.equal(new rab.RegistersTracker().getLuiOffsetForConstant(new rab.Instruction(0x34210001)), null);

    const fresh = new rab.LoPairingInfo();
    assert.equal(fresh.shouldProcess, false);
    fresh.shouldProcess = true;
    assert.equal(fresh.shouldProcess, true);
    assert.throws(() => { fresh.isGpGot = 1; }, TypeError);
    assert.equal(new rab.JrRegData().hasInfo(), false);
    assert.equal(new rab.TrackedRegisterState(5).registerNum, 5);
    tracker.free();
    tracker.free();
  });

  test(`${v}: Utils`, { skip: WASM_SKIP }, () => {
    const rab = loadRabbitizerSync(v);
    assert.equal(rab.Utils.from2Complement(0xFFFF, 16), -1);
    assert.equal(rab.Utils.from2Complement(0x7FFF, 16), 0x7FFF);
    assert.equal(rab.Utils.escapeString('a"b\\c\n\t'), 'a\\"b\\\\c\\n\\t');
    assert.equal(rab.Utils.escapeString("あい"), "あい");
    assert.equal(rab.Utils.escapeString(""), "");
    assert.equal(rab.Utils.floatRepr_32From16(0x3C00), 0x3F800000);
  });
}

test("instructions keep their own struct: interleaved use, mutation and long immOverrides", { skip: WASM_SKIP }, () => {
  const rab = loadRabbitizerSync(DEFAULT_VERSION);
  const a = new rab.Instruction(0x3C018001, 0x80000400);
  const b = new rab.Instruction(0x0C001F24, 0x80000404);
  assert.equal(a.disassemble(), "lui         $at, 0x8001");
  assert.equal(b.disassemble(), "jal         func_80007C90");
  b.vram = 0x80001000;
  a.blankOut();
  assert.equal(b.vram, 0x80001000);
  assert.equal(a.vram, 0x80000400);
  assert.equal(b.getInstrIndexAsVram(), 0x80007C90);
  const long = "sym_" + "x".repeat(20000);
  assert.equal(b.disassemble(long), "jal         " + long);
  assert.equal(new rab.Instruction(0x3C018001).disassemble("%hi(\u30b7\u30f3)"), "lui         $at, %hi(\u30b7\u30f3)");
  let n = 0;
  for (let i = 0; i < 200000; i++) {
    const instr = new rab.Instruction((0x24000000 | i) >>> 0, 0x80000000 + i * 4);
    n += instr.disassemble().length;
  }
  assert.ok(n > 200000 * 20);
});
