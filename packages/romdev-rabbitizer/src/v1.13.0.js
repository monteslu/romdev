// `import * as rabbitizer from "romdev-rabbitizer/1.13.0"`: the rabbitizer 1.13.0
// module namespace, loaded synchronously at import (same object as
// loadRabbitizerSync("1.13.0")).
import { loadRabbitizerSync } from "./index.js";

const rabbitizer = loadRabbitizerSync("1.13.0");
export default rabbitizer;
export const {
  __version__, __version_info__, __author__,
  Utils, config, Enum, Abi, InstrCategory, InstrId, InstrIdType, OperandType, AccessType,
  RegGprO32, RegGprN32, RegCop1O32, RegCop1N32, RegCop1N64, TrinaryValue,
  Instruction, LoPairingInfo, TrackedRegisterState, RegistersTracker, JrRegData,
  RuntimeError, ValueError, IndexError, OverflowError, AssertionError, MemoryError,
} = rabbitizer;
