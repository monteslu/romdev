// --visualize: upstream m2c emits the flow graph as graphviz dot and, by
// default, pipes it through graphviz to SVG. There is no upstream fixture for
// it, so these expectations come from reading translate.py visualize_flowgraph
// and main.py. SVG rendering uses graphviz compiled to WASM (@viz-js/viz).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decompile } from "../src/index.js";

const SRC = process.env.M2C_SRC || path.join(os.homedir(), ".romdev", "tools", "m2c");
const ASM = path.join(SRC, "tests", "end_to_end", "loop", "irix-o2.s");
const skip = fs.existsSync(ASM) ? false : `no upstream checkout at ${SRC}`;

test("dot output follows visualize_flowgraph", { skip }, async () => {
  const r = await decompile(["--visualize", "c", "--visualize-format", "dot", "--function", "test", ASM]);
  assert.equal(r.code, 0);
  const lines = r.stdout.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["digraph {", '  node [shape="rect", fontname="Monospace"];', '  edge [fontname="Monospace"];']);
  assert.equal(lines.at(-2), "}");
  assert.equal(lines.at(-1), "");
  // One node statement per flow graph node, C lines joined with \l, exit node last.
  const nodes = lines.filter((l) => /^ {2}"\d+" \[label=/.test(l));
  assert.equal(nodes.length, 9);
  assert.equal(nodes[0], '  "0" [label="// Node 0 (line 6)\\lvar_v0 = 0;\\lif ((arg1 <= 0))\\l"];');
  assert.equal(nodes.at(-1), '  "8" [label="// Node 8\\l// exit\\l"];');
  // Conditional edges: fallthrough F/blue then taken T/red; basic edges black; return edge bare.
  assert.ok(lines.includes('  "0" -> "1" [label="F", color="blue"];'));
  assert.ok(lines.includes('  "0" -> "7" [label="T", color="red"];'));
  assert.ok(lines.includes('  "2" -> "3" [color="black"];'));
  assert.ok(lines.includes('  "7" -> "8";'));
});

test("asm view lists instructions, marking synthetic ones with *", { skip }, async () => {
  const r = await decompile(["--visualize", "asm", "--visualize-format", "dot", "--function", "test", ASM]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /"7" \[label="\/\/ Node 7 \(line 29\)\\l&nbsp; jr \$ra\\l&nbsp; nop\\l"\]/);
});

test("default --visualize renders SVG through graphviz WASM", { skip }, async () => {
  const r = await decompile(["--visualize", "--function", "test", ASM]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^<\?xml version="1.0" encoding="UTF-8" standalone="no"\?>/);
  assert.match(r.stdout, /<svg [^>]*>/);
  assert.match(r.stdout, /<\/svg>\n?$/);
  assert.equal((r.stdout.match(/<g id="node\d+" class="node">/g) ?? []).length, 9);
  assert.equal((r.stdout.match(/<g id="edge\d+" class="edge">/g) ?? []).length, 13);
  assert.ok(r.stdout.includes("<title>0&#45;&gt;7</title>"));
  assert.ok(r.stdout.includes("// Node 0 (line 6)"));
});
