// ranking-cli.js - the `ranking` group: stamp a closeness ranking with the
// tree it was measured against (the producer's step), and check one before
// ordering work by it (every consumer's step).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkRankingFresh, gitHead, renderFreshness, stampRanking } from "./ranking.js";
import { dumps } from "./pyjson.js";
import { isInputError, osErrorText } from "./py.js";
import { listingSpec } from "./cli.js";

const STAMP_DESCRIPTION = "Record the tree a closeness ranking was measured against. The hash is read from the project's git HEAD unless --tree-hash names one. Re-stamping an unchanged ranking keeps the timestamp it already carries: 'generated_at' says when the measurement was taken, and a field that is refreshed on every run cannot say that.";
const CHECK_DESCRIPTION = "Compare a ranking's stamp with the tree in front of you. A ranking decays within hours -- a function that has since matched is still in it, and the ordering it encodes describes a tree that no longer exists -- so a consumer that orders work by it is entitled to know whether it is reading a measurement or a memory. Exit status is 0 when the stamp matches HEAD and 1 otherwise, including when the ranking carries no stamp at all.";

const expand = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Where to ask git which commit this is (default: the ranking's own directory). */
function root(args, ctx) {
  if (args.project) {
    const directory = ctx.resolve(expand(args.project));
    return isDir(directory) ? directory : path.dirname(directory);
  }
  const p = ctx.resolve(expand(args.path));
  return fs.existsSync(path.dirname(p)) ? path.dirname(p) : ctx.cwd;
}

function displayRoot(args, ctx) {
  // The original names the directory as it was given (not resolved) for --project.
  if (args.project) {
    const directory = expand(args.project);
    return isDir(ctx.resolve(directory)) ? directory : path.dirname(directory);
  }
  return root(args, ctx);
}

const resolvedHash = (args, ctx) => (args.tree_hash ? String(args.tree_hash) : gitHead(root(args, ctx)));

export function rankingStampCommand(args, io, ctx) {
  const treeHash = resolvedHash(args, ctx);
  if (treeHash === null) {
    io.eprint(`error: could not read git HEAD for ${displayRoot(args, ctx)}; pass --tree-hash to stamp explicitly`);
    return 2;
  }
  let result;
  try {
    result = stampRanking(args.path, treeHash, { cwd: ctx.cwd });
  } catch (e) {
    if (!isInputError(e) && !(e instanceof SyntaxError)) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(result.asDict()));
  else {
    io.print(`${result.changed ? "stamped" : "already stamped"}: ${result.path}`);
    io.print(`  tree_hash       ${result.stamp.tree_hash}`);
    io.print(`  generated_at    ${result.stamp.generated_at}`);
  }
  return 0;
}

export function rankingCheckCommand(args, io, ctx) {
  const freshness = checkRankingFresh(args.path, resolvedHash(args, ctx), { cwd: ctx.cwd });
  if (args.json) io.print(dumps(freshness.asDict()));
  else io.print(renderFreshness(freshness).join("\n"));
  return freshness.fresh ? 0 : 1;
}

const shared = () => [
  { dest: "path", help: "the ranking JSON to stamp or check" },
  { flags: ["--project"], metavar: "PATH", help: "the project directory whose git HEAD to read (default: the ranking's own directory)" },
  { flags: ["--tree-hash"], metavar: "HASH", help: "use this hash instead of asking git" },
  { flags: ["--json"], action: "store_true", help: "emit JSON" },
];

export const COMMAND_SPECS = [
  listingSpec(["ranking"], {
    help: "stamp a closeness ranking with its tree, and check its freshness",
    description: "A closeness ranking is a measurement of one tree and decays as soon as that tree moves. Stamp it when it is produced, check it before ordering work by it."
  }),
  { path: ["ranking", "stamp"], handler: rankingStampCommand, help: "record the tree hash a ranking was measured against",
    description: STAMP_DESCRIPTION, epilog: "example: decomp-workbench ranking stamp config/ranking.json",
    arguments: shared(), defaults: { report_command: "ranking-stamp" } },
  { path: ["ranking", "check"], handler: rankingCheckCommand, help: "report whether a ranking still describes the current tree",
    description: CHECK_DESCRIPTION, epilog: "example: decomp-workbench ranking check config/ranking.json",
    arguments: shared(), defaults: { report_command: "ranking-check" } },
];
