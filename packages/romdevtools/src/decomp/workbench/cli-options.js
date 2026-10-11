// cli-options.js - argument groups shared by many commands, so an option
// means the same thing (and is spelled the same way) wherever it appears.
// Each function returns ArgSpec entries for argparse.js.
//
// Plain JS ESM + JSDoc.

import { ArgumentTypeError } from "./argparse.js";
import { REGISTER_CLASS_PROFILES, REGISTER_PROFILE_EVIDENCE } from "./view.js";

export const DEFAULT_STREAM_LIMIT = 64 * 1024;
export const SYMBOL_HELP = "compare only this exact symbol; --function is the same option";
export const SYMBOL_OMISSION_HELP = "Omitting it compares the whole section positionally - only safe when both objects hold the same single function.";
export const SHOW_ALL_HELP = "render every hunk and the full lanes (overrides the two above)";
export const WATCH_ROWS_HELP = "watch these positional rows and print a healed/broken column for each "
  + "(. healed, X broken, ? out of range). Takes 49,1620,1677, or "
  + "r49=49,cx2=1620 to name the columns, or @probes.json for a named set. "
  + "Scalar metrics conflate schedule with allocation and over-charge block "
  + "permutations; a signature over rows you chose because they discriminate "
  + "does neither";

/** `--symbol` / `--function`: one selector, two spellings, conflicts refused. */
export function symbolArgument({ help = SYMBOL_HELP } = {}) {
  return [{ flags: ["--symbol", "--function"], dest: "symbol", action: "symbol", metavar: "NAME", help: `${help.replace(/[. ]+$/, "")}. ${SYMBOL_OMISSION_HELP}` }];
}

export function explainKeysArgument() {
  return [{ flags: ["--explain-keys"], action: "explain_keys", help: "print the metric registry (label, JSON key, meaning) and exit" }];
}

export function watchRowsArgument() {
  return [{ flags: ["--watch-rows"], metavar: "ROWS", default: null, help: WATCH_ROWS_HELP }];
}

export function censusArgument() {
  return [{ flags: ["--census"], action: "append", default: [], metavar: "KEY=VALUE[,KEY=VALUE...]",
    help: "assert reported values; exit 3 if any predicate fails (2 for an unknown key), and print one PASS/FAIL line each. Repeatable" }];
}

export function candidateListingArgument() {
  return [{ flags: ["--candidate-listing"], metavar: "PATH",
    help: "the assembly listing ugen wrote for the candidate, used to report whether schedule-divergent sites sit at .loc statement-line boundaries; the IDO driver keeps it beside the object when you pass `cc -K`, and `ugen -l` writes it directly" }];
}

/** `--<option>-from FILE`: one value per line, # comments ignored. */
export function listFileArgument({ option, dest, noun, itemType = null }) {
  return [{ flags: [`--${option}-from`], dest, action: "list_file", itemType, metavar: "FILE",
    help: `read ${noun} from FILE, one per line (- for stdin); blank lines and # comments are ignored. Use this rather than expanding a shell variable: zsh does not word-split one, so the whole list arrives as a single argument` }];
}

export function processOutputArguments() {
  return [
    { flags: ["--stream-limit"], type: "int", default: DEFAULT_STREAM_LIMIT, metavar: "BYTES", help: `maximum retained bytes per compiler stream (default: ${DEFAULT_STREAM_LIMIT})` },
    { flags: ["--artifact-dir"], help: "retain complete compiler stdout/stderr here" },
  ];
}

export function colorArgument() {
  return [{ flags: ["--color"], choices: ["auto", "always", "never"], default: "auto", help: "ANSI coloring; every label and annotation is present without it" }];
}

/** `--width`: auto is -1, unlimited is 0, else at least 20 columns. */
export function terminalWidth(value) {
  if (value === "auto") return -1;
  if (value === "unlimited" || value === "none") return 0;
  if (!/^\s*[-+]?\d+\s*$/.test(value)) throw new ArgumentTypeError("width must be auto, unlimited, or a positive integer");
  const width = parseInt(value, 10);
  if (width < 20) throw new ArgumentTypeError("width must be at least 20 columns");
  return width;
}
terminalWidth.displayName = "terminal_width";

export function terminalArguments() {
  return [
    { flags: ["--width"], type: terminalWidth, default: 0, metavar: "COLUMNS", help: "bound terminal lines; use auto or unlimited (default: unlimited)" },
    { flags: ["--pager"], choices: ["auto", "always", "never"], default: "auto", help: "page long human output (default: auto on a TTY)" },
  ];
}

export function viewRenderArguments({ defaultMaxHunks = 20, showAllHelp = SHOW_ALL_HELP } = {}) {
  const profiles = Object.keys(REGISTER_CLASS_PROFILES).sort();
  return [
    { flags: ["--report-regs"], action: "store_true", help: "report per-aligned-index register operands, matching rows included" },
    { flags: ["--terse"], action: "store_true", help: "drop the one-line orientation notes; every label and count stays" },
    { flags: ["--context"], type: "int", default: 2, help: "aligned rows of context around each hunk (default: 2)" },
    { flags: ["--max-hunks"], type: "int", default: defaultMaxHunks, help: `maximum hunks to render; 0 renders all (default: ${defaultMaxHunks})` },
    { flags: ["--lane-window"], type: "int", default: 32, help: "lane slots to render around a divergence (default: 32)" },
    { flags: ["--show-all"], action: "store_true", help: showAllHelp },
    { flags: ["--register-profile"], default: "ido53", choices: profiles,
      help: "compiler era whose register class table the lanes use (default: ido53). " + profiles.map((n) => `${n}: ${REGISTER_PROFILE_EVIDENCE[n]}`).join("; ") },
    { flags: ["--target-reservations"], help: "input-hash/symbol-bound JSON with supplied conditional IDO 5.3 shared GP reservations (not automatic trace proof)" },
    { flags: ["--candidate-reservations"], help: "input-hash/symbol-bound JSON with supplied conditional IDO 5.3 shared GP reservations (not automatic trace proof)" },
    ...colorArgument(),
  ];
}

export function viewOutputArguments() {
  return [
    ...terminalArguments(),
    { flags: ["--html"], metavar: "PATH", help: "write a self-contained aligned evidence report" },
    { flags: ["--emit-force-spec"], metavar: "PATH", help: "write a register-permutation oracle handoff" },
  ];
}

export function freshnessArguments() {
  return [
    { flags: ["--built-from"], action: "append", metavar: "PATH",
      help: "an input the compared artifacts were built from -- the source, the object, the ELF. Repeatable. The command refuses when a compared artifact is older than one of these" },
    { flags: ["--allow-stale"], action: "store_true", help: "report the staleness and continue anyway, instead of refusing. The report is printed either way" },
  ];
}
