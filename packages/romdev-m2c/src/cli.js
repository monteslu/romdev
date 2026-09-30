#!/usr/bin/env node
// Command-line entry point taking the same flags as upstream m2c's CLI.
import { decompile } from "./main.js";

const r = await decompile(process.argv.slice(2));
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.code;
