// A stand-in GNU objdump for workbench tests: an executable node script that
// prints canned `objdump -d -r` text per object basename, so object-shaped
// commands run end to end without a real MIPS binutils. `-h`, `-s`, `-t`
// and `-r` requests print the matching canned text when one was supplied.
import fs from "node:fs";
import path from "node:path";

/**
 * Write the fake into `dir` and return its path.
 * @param {string} dir
 * @param {Record<string, string|{d?: string, sym?: Record<string,string>, h?: string, s?: Record<string,string>, t?: string, r?: string, fail?: string}>} texts by object basename
 */
export function fakeObjdump(dir, texts) {
  const table = path.join(dir, "fake-objdump.json");
  fs.writeFileSync(table, JSON.stringify(texts));
  const exe = path.join(dir, "objdump");
  fs.writeFileSync(exe, `#!${process.execPath}
const fs = require("fs"), path = require("path");
const table = JSON.parse(fs.readFileSync(${JSON.stringify(table)}, "utf8"));
const args = process.argv.slice(2);
const file = [...args].reverse().find((a) => !a.startsWith("-") && table[path.basename(a)] !== undefined) ?? args.find((a) => !a.startsWith("-") && a.includes("."));
const entry = table[path.basename(file ?? "")];
if (entry === undefined) { process.stderr.write("objdump: '" + file + "': No such file\\n"); process.exit(1); }
const e = typeof entry === "string" ? { d: entry } : entry;
if (e.fail) { process.stderr.write(e.fail + "\\n"); process.exit(1); }
if (args.includes("-h")) { process.stdout.write(e.h ?? ""); process.exit(0); }
if (args.includes("-s")) { const j = args[args.indexOf("-j") + 1]; process.stdout.write((e.s ?? {})[j] ?? ""); process.exit(0); }
if (args.includes("-t")) { process.stdout.write(e.t ?? ""); process.exit(0); }
if (args.includes("-r") && !args.includes("-d")) { process.stdout.write(e.r ?? ""); process.exit(0); }
const sym = (args.find((a) => a.startsWith("--disassemble=")) ?? "").slice("--disassemble=".length);
process.stdout.write(sym && e.sym && e.sym[sym] !== undefined ? e.sym[sym] : e.d ?? "");
`, { mode: 0o755 });
  return exe;
}
