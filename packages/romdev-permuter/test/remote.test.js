// permuter@home over loopback: the controller (romdev-permuter-remote-controller, bin/remote-controller.mjs), a worker
// server (romdev-permuter-remote run-server, with its evaluator process) and a -J client
// (permuter.mjs -J -j 0, so every candidate is evaluated remotely), all on
// 127.0.0.1. Access is granted the upstream way: `romdev-permuter-remote setup` on the
// worker's side, `romdev-permuter-remote vouch` by the root user, the sealed token pasted back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run_controller, run_setup } from "../src/net/controller.js";
import { resolveToolchainUrl } from "../src/import.js";
import { _make_script_portable } from "../src/net/client.js";
import { bindScript, profilePrograms } from "../src/net/evaluator.js";
import { pyJsonLoads, pyJsonDumps } from "../src/net/core.js";
import { workDir, removeDir } from "./helpers/work.js";
import { IDO } from "./helpers/payloads.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin");
const toolchain = resolveToolchainUrl();

test("compile scripts travel portably and bind to the server's toolchain profile", () => {
  const script = "#!/usr/bin/env bash\nINPUT=\"$(realpath \"$1\")\"\nOUTPUT=\"$(realpath \"$3\")\"\ncd '/home/x/proj'\n"
    + "/home/x/proj/tools/ido/5.3/cc -c -O2 \"$INPUT\" -o \"$OUTPUT\"\n";
  const portable = _make_script_portable(script);
  assert.equal(portable, "#!/usr/bin/env bash\nINPUT=\"$(realpath \"$1\")\"\nOUTPUT=\"$(realpath \"$3\")\"\n$(which cc) -c -O2 \"$INPUT\" -o \"$OUTPUT\"\n");
  assert.match(bindScript(portable, profilePrograms("romdev:ido5.3")), /^ido\/5\.3\/cc -c -O2 "\$INPUT"/m);
  assert.throws(() => bindScript("$(which gcc) -c x", profilePrograms("romdev:ido5.3")), /needs program 'gcc'/);
  assert.throws(() => bindScript("$(which cc) -I/etc -c \"$INPUT\"", profilePrograms("romdev:ido5.3")), /outside its job directory/);
  assert.throws(() => bindScript("cd /\n$(which cc) x", profilePrograms("romdev:ido5.3")), /may not change directory/);
});

test("u64 seeds survive the JSON wire format", () => {
  const seed = 18446744073709551615n;
  const wire = pyJsonDumps({ type: "work", work: { seed } });
  assert.equal(wire, '{"type": "work", "work": {"seed": 18446744073709551615}}');
  assert.equal(pyJsonLoads(wire).work.seed, seed);
  assert.equal(pyJsonLoads('{"a": 5}').a, 5);
});

/** Spawn a node script; resolves {code, stdout, stderr}. `onOut(text, child)` sees stdout as it arrives. */
function spawnNode(args, { cwd, onOut, timeoutMs = 240_000 } = {}) {
  const child = spawn(process.execPath, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; child.out = stdout; onOut?.(stdout, child); });
  child.stderr.on("data", (d) => { stderr += d; child.err = stderr; });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const done = new Promise((resolve) => child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); }));
  return { child, done };
}

test("permuter@home loopback: setup, vouch, run-server and a -J client that finds the match remotely",
  { skip: (!toolchain && "romdev's toolchain adapter (romdevtools) is not available") || IDO, timeout: 300_000 }, async () => {
    const root = workDir("pah");
    let controller = null;
    let worker = null;
    try {
      const rootDir = path.join(root, "root");
      const workerDir = path.join(root, "worker");
      mkdirSync(rootDir);
      mkdirSync(workerDir);

      // Controller: setup prints the server seed and the root client's keys.
      const db = path.join(root, "db.json");
      const setupText = await run_setup(db);
      const hex = (k) => new RegExp(`${k} = "([0-9a-f]{64})"`).exec(setupText)[1];
      writeFileSync(path.join(root, "config.toml"), `docker_image = "romdev:ido5.3"\npriv_seed = "${hex("priv_seed")}"\n`);
      const logs = [];
      controller = await run_controller({ listen_on: "127.0.0.1:0", config: path.join(root, "config.toml"), db, log: (s) => logs.push(s), saveIntervalMs: 50 });
      writeFileSync(path.join(rootDir, "pah.conf"),
        `secret_key = "${hex("secret_key")}"\nserver_public_key = "${hex("server_public_key")}"\nserver_address = "127.0.0.1:${controller.port}"\n`);

      // ping as root.
      // (spawned, not execFileSync: the controller runs on this event loop)
      const ping = (await spawnNode([path.join(BIN, "remote.mjs"), "ping"], { cwd: rootDir }).done).stdout;
      assert.match(ping, /Connected successfully! Round-trip time: [\d.]+ ms\n0 servers online \(0 cores, 0 clients\)/);

      // The worker's owner asks for access; root vouches; the token goes back.
      let vouchCmd = null;
      const setup = spawnNode([path.join(BIN, "remote.mjs"), "setup"], {
        cwd: workerDir,
        onOut: (text, child) => {
          if (/Nickname \[default: [^\]]*\]: $/.test(text) && !child.sentNick) { child.sentNick = true; child.stdin.write("worker\n"); }
          const m = /romdev-permuter-remote vouch (\S+)\n/.exec(text);
          if (m && !vouchCmd) vouchCmd = m[1];
        },
      });
      while (!vouchCmd) await new Promise((r) => setTimeout(r, 50));
      const vouch = spawnNode([path.join(BIN, "remote.mjs"), "vouch", vouchCmd], {
        cwd: rootDir,
        onOut: (text, child) => { if (/Grant permuter server access to worker \(Y\/n\)\? $/.test(text) && !child.sent) { child.sent = true; child.stdin.write("y\n"); } },
      });
      const v = await vouch.done;
      assert.equal(v.code, 0, v.stdout + v.stderr);
      const token = /Send them the following token:\n(\S+)\n/.exec(v.stdout)[1];
      setup.child.stdin.write(token + "\n");
      const s = await setup.done;
      assert.equal(s.code, 0, s.stdout + s.stderr);
      assert.match(s.stdout, new RegExp(`Server: 127\\.0\\.0\\.1:${controller.port}\\nTesting connection...\\npermuter@home successfully set up!`));
      const workerConf = readFileSync(path.join(workerDir, "pah.conf"), "utf8");
      assert.match(workerConf, /secret_key = "[0-9a-f]{64}"/);
      assert.doesNotMatch(workerConf, /initial_setup_nickname/);
      const users = Object.values(JSON.parse(readFileSync(db, "utf8")).users).map((u) => u.name).sort();
      assert.deepEqual(users, ["root", "worker"]);

      // The worker server (its evaluator runs the WASM IDO toolchain).
      let serverUp = false;
      worker = spawnNode([path.join(BIN, "remote.mjs"), "run-server", "--cores", "2", "--memory", "2"], {
        cwd: workerDir, onOut: (text) => { if (/Started\./.test(text)) serverUp = true; },
      });
      for (let k = 0; k < 600 && !(serverUp && logs.some((l) => /\[worker\] start server \(0\.1, 2\)/.test(l))); k++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(serverUp, logs.join("\n"));

      // A permuter job whose first permutation misses and whose second matches.
      const proj = path.join(rootDir, "proj");
      mkdirSync(path.join(proj, "tools", "ido", "5.3"), { recursive: true });
      const job = path.join(rootDir, "job");
      mkdirSync(job);
      const compileSh = path.join(job, "compile.sh");
      writeFileSync(compileSh, `#!/usr/bin/env bash\nINPUT="$(realpath "$1")"\nOUTPUT="$(realpath "$3")"\ncd '${proj}'\n`
        + `'${proj}/tools/ido/5.3/cc' -c -G 0 -non_shared -O2 -mips2 -32 "$INPUT" -o "$OUTPUT"\n`, { mode: 0o755 });
      writeFileSync(path.join(job, "target.c"), "int f(int a) {\n    return a + 1;\n}\n");
      const { compileScript } = await import(toolchain);
      assert.ok(await compileScript({ script: compileSh, input: path.join(job, "target.c"), output: path.join(job, "target.o") }));
      writeFileSync(path.join(job, "base.c"), "int f(int a) {\n    return PERM_GENERAL(a + 2, a + 1);\n}\n");
      writeFileSync(path.join(job, "settings.toml"), "func_name = \"f\"\ncompiler_type = \"ido\"\n");

      const client = spawnNode([path.join(BIN, "permuter.mjs"), job, "-J", "--stop-on-zero"], { cwd: rootDir, timeoutMs: 120_000 });
      const c = await client.done;
      if (process.env.PAH_TEST_SHOW) process.stderr.write(c.stdout);
      assert.equal(c.code, 0, `${c.stdout}${c.stderr}\n--- worker:\n${worker.child.out}${worker.child.err}`);
      assert.match(c.stdout, /Connecting to permuter@home\.\.\.\nConnected! 1 server online \(2 cores, 0 other clients\)/);
      assert.match(c.stdout, /\[f\] base score = \d+/);
      assert.match(c.stdout, /\[worker\] connected\n/, "the worker reported the job initialised");
      assert.match(c.stdout, /\[worker\] \[f\] found new best score! \(0 vs 5\)/, "the match was found by the remote worker");
      assert.match(c.stdout, /Found zero score! Exiting\./);
      const outDir = readdirSync(job).find((d) => d.startsWith("output-0-"));
      assert.ok(outDir, readdirSync(job).join(" "));
      assert.match(readFileSync(path.join(job, outDir, "source.c"), "utf8"), /return a \+ 1;/);
      assert.ok(logs.some((l) => /\[root\] start client \(f, 1\)/.test(l)), logs.join("\n"));

      // Without --stop-on-zero the client runs the space out and still collects
      // every result that was out on the network before hanging up.
      const c2 = await spawnNode([path.join(BIN, "permuter.mjs"), job, "-J"], { cwd: rootDir, timeoutMs: 120_000 }).done;
      assert.equal(c2.code, 0, c2.stdout + c2.stderr);
      assert.match(c2.stdout, /iteration 2, 0 errors, score = \d+\n/);
      assert.match(c2.stdout, /found new best score! \(0 vs 5\)/);

      // Control: a key nobody vouched for is turned away.
      const strangerDir = path.join(root, "stranger");
      mkdirSync(strangerDir);
      writeFileSync(path.join(strangerDir, "pah.conf"),
        `secret_key = "${"ab".repeat(32)}"\nserver_public_key = "${hex("server_public_key")}"\nserver_address = "127.0.0.1:${controller.port}"\n`);
      const denied = await spawnNode([path.join(BIN, "remote.mjs"), "ping"], { cwd: strangerDir }).done;
      assert.equal(denied.code, 1);
      assert.equal(denied.stdout, "Error: Access denied!\n");

      // The controller counted the remote work for both users.
      await new Promise((r) => setTimeout(r, 200));
      controller.state.db.flush();
      const saved = JSON.parse(readFileSync(db, "utf8"));
      const byName = Object.fromEntries(Object.values(saved.users).map((u) => [u.name, u]));
      assert.ok(saved.func_stats.f[0] >= 1 && saved.func_stats.f[2] >= 1, JSON.stringify(saved));
      assert.equal(saved.func_stats.f[3], 2);
      assert.ok(byName.root.client_stats[2] >= 1 && byName.worker.server_stats[2] >= 1, JSON.stringify(saved));
      assert.equal(byName.worker.server_stats[3], 2);
    } finally {
      if (worker) { worker.child.kill("SIGINT"); await Promise.race([worker.done, new Promise((r) => setTimeout(r, 5000))]); worker.child.kill("SIGKILL"); }
      await controller?.close();
      if (!existsSync(path.join(root, "keep"))) removeDir(root);
    }
  });
