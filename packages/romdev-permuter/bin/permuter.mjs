#!/usr/bin/env node
// romdev-permuter CLI: decomp-permuter's permuter.py flags, run in node.
//   romdev-permuter <dir>... [-j N] [--stop-on-zero] [--seed [i,]N] ...
// -J runs through permuter@home (src/net/), with no local threads unless -j is given.
import { run, PermuterUsageError, DEFAULT_RAND_KEEP_PROB } from "../src/main.js";
import { RANDOMIZATION_PASSES, PASS_DOCS } from "../src/randomizer.js";

const usage = `usage: romdev-permuter [-h] [--help=randomization-passes] [--show-errors] [--show-timings]
       [--print-diffs] [--abort-exceptions] [--better-only] [--best-only] [--stop-on-zero] [--quiet]
       [--stack-diffs] [--algorithm {difflib,levenshtein}] [--keep-prob PROB] [-j THREADS] [-J] [--pah-debug]
       [--priority PRIORITY] [--no-context-output]
       [--only-if-below N] [--debug] [--speed [1-100]] [--no-ignore-branch-targets] [--seed SEED]
       directory [directory ...]`;

function fail(msg) {
  process.stderr.write(`${usage}\nromdev-permuter: error: ${msg}\n`);
  process.exit(2);
}

const opts = { directories: [], threads: 0 };
const argv = process.argv.slice(2);
const floatIn = (v, lo, hi, flag) => {
  const x = Number(v);
  if (!Number.isFinite(x)) fail(`argument ${flag}: invalid float value: '${v}'`);
  if (x < lo || x > hi) fail(`argument ${flag}: value ${v} is out of range (must be between ${lo} and ${hi})`);
  return x;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const [flag, inline] = a.startsWith("--") && a.includes("=") && a !== "--help=randomization-passes" ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
  const val = () => {
    if (inline != null) return inline;
    if (i + 1 >= argv.length) fail(`argument ${flag}: expected one argument`);
    return argv[++i];
  };
  switch (flag) {
    case "-h": case "--help": process.stdout.write(usage + "\n"); process.exit(0); break;
    case "--help=randomization-passes":
      for (const m of RANDOMIZATION_PASSES) process.stdout.write(`${m.name}:\n  ${PASS_DOCS[m.name]}\n\n`);
      process.exit(0); break;
    case "--show-errors": opts.show_errors = true; break;
    case "--show-timings": opts.show_timings = true; break;
    case "--print-diffs": opts.print_diffs = true; break;
    case "--abort-exceptions": opts.abort_exceptions = true; break;
    case "--better-only": opts.better_only = true; break;
    case "--best-only": opts.best_only = true; break;
    case "--stop-on-zero": opts.stop_on_zero = true; break;
    case "--quiet": opts.quiet = true; break;
    case "--stack-diffs": opts.stack_differences = true; break;
    case "--algorithm": { const v = val(); if (v !== "difflib" && v !== "levenshtein") fail(`argument --algorithm: invalid choice: '${v}' (choose from 'difflib', 'levenshtein')`); opts.algorithm = v; break; }
    case "--keep-prob": opts.keep_prob = floatIn(val(), 0, 1, "--keep-prob"); break;
    case "--seed": opts.force_seed = val(); break;
    case "-j": { const v = val(); opts.threads = parseInt(v, 10); if (!Number.isInteger(opts.threads)) fail(`argument -j: invalid int value: '${v}'`); break; }
    case "-J": opts.use_network = true; break;
    case "--pah-debug": opts.network_debug = true; break;
    case "--priority": opts.network_priority = floatIn(val(), 0.01, 2.0, "--priority"); break;
    case "--no-context-output": opts.no_context_output = true; break;
    case "--only-if-below": opts.score_threshold = parseInt(val(), 10); break;
    case "--debug": opts.debug_mode = true; break;
    case "--speed": { const s = parseInt(val(), 10); if (!(s >= 1 && s <= 100)) fail("argument --speed: invalid choice"); opts.speed = s; break; }
    case "--no-ignore-branch-targets": opts.ign_branch_targets = false; break;
    default:
      if (a.startsWith("-") && a.length > 1) {
        if (/^-j\d+$/.test(a)) { opts.threads = parseInt(a.slice(2), 10); break; }
        fail(`unrecognized arguments: ${a}`);
      }
      opts.directories.push(a);
  }
}
if (!opts.directories.length) fail("the following arguments are required: directory");
if (!opts.threads && !opts.use_network) opts.threads = 1;
opts.keep_prob ??= DEFAULT_RAND_KEEP_PROB;

// Each directory's compile.sh runs through romdev's toolchain adapter when one
// is available (no bash, no host compiler); otherwise upstream's
// `bash compile.sh`.
const { resolveToolchainUrl } = await import("../src/import.js");
const toolchainUrl = resolveToolchainUrl();
if (toolchainUrl && !process.env.ROMDEV_PERMUTER_BASH_COMPILE) opts.compileModule = { url: toolchainUrl, name: "compileWithScript" };

const ac = new AbortController();
process.on("SIGINT", () => ac.abort());
process.on("SIGTERM", () => ac.abort());
try {
  await run({ ...opts, signal: ac.signal });
  process.exit(0);
} catch (e) {
  if (e instanceof PermuterUsageError) {
    process.stderr.write(e.message + "\n");
    process.exit(1);
  }
  throw e;
}
