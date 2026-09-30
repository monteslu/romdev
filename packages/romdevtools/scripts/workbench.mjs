#!/usr/bin/env node
// Run one decomp workbench command from a shell (the same in-process commands
// the decomp({op:'workbench'}) tool runs): node scripts/workbench.mjs <command...>
//
// On a terminal, long human output goes through the user's pager
// ($MANPAGER, $PAGER, else less) exactly when the command asks for it
// (--pager always, or --pager auto with more lines than the terminal has).
import { spawn } from "node:child_process";
import { runCommand } from "../src/decomp/workbench/cli.js";

const terminal = { isTTY: !!(process.stdout.isTTY && process.stdin.isTTY), columns: process.stdout.columns, rows: process.stdout.rows };
const r = await runCommand(process.argv.slice(2), { cwd: process.cwd(), terminal });
process.stderr.write(r.stderr);
if (r.page && terminal.isTTY) {
  const pager = process.env.MANPAGER || process.env.PAGER || "less";
  await new Promise((resolve) => {
    const child = spawn(pager, { shell: true, stdio: ["pipe", "inherit", "inherit"], env: { LESS: "-R", ...process.env } });
    child.on("error", () => { process.stdout.write(r.stdout); resolve(); });
    child.on("close", resolve);
    child.stdin.on("error", () => {});
    child.stdin.end(r.stdout);
  });
} else {
  process.stdout.write(r.stdout);
}
process.exitCode = r.code;
