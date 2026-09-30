// romdev-permuter - a plain-JS port of decomp-permuter
// (https://github.com/simonlindholm/decomp-permuter, pinned
// 41bd0bfc32aa5ea78de4cf28be603163256c2a4c): PERM macros, the randomization
// passes, the objdump-diff scorer and the compile.sh contract, running
// candidate evaluation in node worker threads.
export { run, makeOptions, cycle_seeds, PermuterUsageError, DEFAULT_RAND_KEEP_PROB } from "./main.js";
export { Permuter } from "./permuter.js";
export { Candidate } from "./candidate.js";
export { Compiler } from "./compiler.js";
export { Scorer, PENALTY_INF } from "./scorer.js";
export { Randomizer, RANDOMIZATION_PASSES, PASS_DOCS, RandomizationFailure } from "./randomizer.js";
export { perm_parse } from "./perm/parse.js";
export { perm_evaluate_one, perm_gen_all_seeds } from "./perm/eval.js";
export { EvalState } from "./perm/perm.js";
export { simplify_objdump, get_arch, setObjdumpGlue, resolveObjdumpGlue, objdump, MIPS_SETTINGS, PPC_SETTINGS, ARM32_SETTINGS, X86_SETTINGS } from "./objdump.js";
export { SequenceMatcher, unified_diff } from "./difflib.js";
export { runWasmTool } from "./wasm-tool.js";
export { PyRandom } from "./pyrandom.js";
export { get_default_randomization_weights, merge_randomization_weights, get_settings, parseToml, trim_source, DEFAULT_WEIGHTS_FILE } from "./helpers.js";

/** The upstream this package ports. */
export const UPSTREAM = Object.freeze({ repo: "https://github.com/simonlindholm/decomp-permuter.git", commit: "41bd0bfc32aa5ea78de4cf28be603163256c2a4c" });
export { preprocess, PreprocessorRequired } from "./preprocess.js";
export * as ast_util from "./ast_util.js";
export * as ast_types from "./ast_types.js";
export { CandidateConstructionFailure } from "./error.js";
export { importMain, parseImportArgs, ImportExit, resolveToolchain, resolveToolchainUrl, DEFAULT_ASM_PRELUDE_FILE } from "./import.js";
export { editops as levenshteinEditops, opcodes as levenshteinOpcodes } from "./levenshtein.js";
export { libmPow, powNeg15 } from "./pow.js";
