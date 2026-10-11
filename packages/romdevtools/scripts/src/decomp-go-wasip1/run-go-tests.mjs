// Run Go test binaries built with `GOOS=wasip1 go test -c` under node:wasi the
// way romdev runs the tools themselves (src/decomp/wasi-run.js, including the
// `romdev` exec imports), each in its package directory like `go test`.
// usage: node run-go-tests.mjs <tests dir> <module root> <tmp dir>
// Some tests read the project's extracted disc (disks/us): point <module root>
// at the asset tool's module (tools/<name>-assets) inside a checkout of the
// pinned commit that has one.
// A test binary named a_b.test.wasm is package ./a/b (main.test.wasm = .).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [testsDir, modRoot, tmpDir] = process.argv.slice(2).map((p) => path.resolve(p));
const here = path.dirname(fileURLToPath(import.meta.url));
const { runWorkerJob } = await import(path.join(here, "../../../src/decomp/wasi-run.js"));
const repoRoot = path.resolve(modRoot, "../..");
// WASI has no permission bits (fd_filestat has no mode), so a copy cannot
// "preserve" 0755; MirrorDir only serves the project's expected/ snapshot.
const SKIP = "^TestMirrorDirPreservesMode$";
let failed = 0, passed = 0;
for (const f of fs.readdirSync(testsDir).filter((x) => x.endsWith(".test.wasm")).sort()) {
  const pkg = f === "main.test.wasm" ? "." : f.replace(/\.test\.wasm$/, "").replace(/_/g, "/");
  const cwd = path.join(modRoot, pkg);
  // t.TempDir() / os.TempDir(): TMPDIR, preopened like the tree.
  const testTmp = path.join(tmpDir, "gotest-tmp"); fs.mkdirSync(testTmp, { recursive: true });
  const r = await runWorkerJob({ wasm: path.join(testsDir, f), argv: [f, "-test.v", "-test.skip", SKIP], cwd, env: { TMPDIR: testTmp }, preopens: [repoRoot, testTmp], tmpDir });
  fs.rmSync(testTmp, { recursive: true, force: true });
  const ok = r.exitCode === 0;
  const counts = (s) => (r.log.match(new RegExp(`^--- ${s}`, "gm")) ?? []).length;
  console.log(`${ok ? "ok  " : "FAIL"} ${pkg}  (${counts("PASS")} passed, ${counts("FAIL")} failed, ${counts("SKIP")} skipped)`);
  if (!ok) { failed++; console.log(r.log.split("\n").filter((l) => /FAIL|Error|error|panic/.test(l)).slice(0, 30).join("\n")); } else passed++;
}
console.log(`${passed} packages passed, ${failed} failed`);
const { shutdown } = await import(path.join(here, "../../../src/toolchains/_worker/pool.js"));
await shutdown();
process.exit(failed ? 1 : 0);
