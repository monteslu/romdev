#!/usr/bin/env node
// Command-line entry point equivalent to `python3 m2c.py ...`.
import { decompile } from "./main.js";

const r = await decompile(process.argv.slice(2));
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.code;
