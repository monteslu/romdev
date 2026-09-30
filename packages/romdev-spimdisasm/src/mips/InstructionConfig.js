// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/InstructionConfig.py
//
// The upstream class only wires argparse options to rabbitizer.config. The CLI
// frontends are not ported, so parseArgs accepts a plain object with the same
// attribute names argparse would produce.

import { rabbitizer } from "../rabbitizer.js";
import { GlobalConfig, Abi } from "../common/GlobalConfig.js";
import { pyInt } from "../py/pyutils.js";

export class InstructionConfig {
  static addParametersToArgParse(_parser) {
    throw new Error("InstructionConfig.addParametersToArgParse: argparse frontends are not ported");
  }

  static parseArgs(args) {
    const has = (k) => args[k] !== null && args[k] !== undefined;
    if (has("named_registers")) rabbitizer.config.regNames_namedRegisters = args.named_registers;

    if (GlobalConfig.ABI !== Abi.O32) {
      rabbitizer.config.regNames_gprAbiNames = rabbitizer.Abi.fromStr(GlobalConfig.ABI.name);
      rabbitizer.config.regNames_fprAbiNames = rabbitizer.Abi.fromStr(GlobalConfig.ABI.name);
    }

    if (args.Mgpr_names) rabbitizer.config.regNames_gprAbiNames = rabbitizer.Abi.fromStr(args.Mgpr_names);
    if (args.Mfpr_names) rabbitizer.config.regNames_fprAbiNames = rabbitizer.Abi.fromStr(args.Mfpr_names);
    if (args.Mreg_names) {
      rabbitizer.config.regNames_gprAbiNames = rabbitizer.Abi.fromStr(args.Mreg_names);
      rabbitizer.config.regNames_fprAbiNames = rabbitizer.Abi.fromStr(args.Mreg_names);
    }

    if (has("use_fpccsr")) rabbitizer.config.regNames_userFpcCsr = args.use_fpccsr;
    if (has("cop0_named_registers")) rabbitizer.config.regNames_vr4300Cop0NamedRegisters = args.cop0_named_registers;
    if (has("rsp_cop0_named_registers")) rabbitizer.config.regNames_vr4300RspCop0NamedRegisters = args.rsp_cop0_named_registers;
    if (has("pseudo_instr")) rabbitizer.config.pseudos_enablePseudos = args.pseudo_instr;
    if (has("j_branch")) rabbitizer.config.toolchainTweaks_treatJAsUnconditionalBranch = args.j_branch;
    if (has("sn64_div_fix")) rabbitizer.config.toolchainTweaks_sn64DivFix = args.sn64_div_fix;
    if (has("opcode_ljust")) rabbitizer.config.misc_opcodeLJust = pyInt(String(args.opcode_ljust), 0);
    if (has("unk_instr_comment")) rabbitizer.config.misc_unknownInstrComment = args.unk_instr_comment;
  }
}
