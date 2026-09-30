import fs from "node:fs";
// Compare romdev's --help for every parser against the oracle's output.
import { runCommand } from "../../src/decomp/workbench/cli.js";
const golden = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let same = 0; const diff = [];
process.env.COLUMNS = "80";
for (const [prog, text] of Object.entries(golden)) {
  const words = prog.split(" ").slice(1);
  const r = await runCommand([...words, "--help"]);
  if (r.stdout === text) same++;
  else diff.push({ prog, want: text, got: r.stdout + (r.stderr ? "\n[stderr] " + r.stderr : "") });
}
fs.writeFileSync(process.argv[3], JSON.stringify(diff, null, 1));
console.log(`identical ${same} / ${Object.keys(golden).length}; differing ${diff.length}`);
for (const d of diff.slice(0, 400)) {
  const a = d.want.split("\n"), b = d.got.split("\n");
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  console.log(`- ${d.prog}: line ${i + 1}\n    want: ${JSON.stringify(a[i] ?? "<eof>").slice(0, 150)}\n    got:  ${JSON.stringify(b[i] ?? "<eof>").slice(0, 150)}`);
}
