#!/usr/bin/env node
// Run one decomp workbench command from a shell (the same in-process commands
// the decomp({op:'workbench'}) tool runs): node scripts/workbench.mjs <command...>
import { runCommand } from "../src/decomp/workbench/cli.js";

const r = await runCommand(process.argv.slice(2), { cwd: process.cwd() });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.code;
