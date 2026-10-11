// The server process runs with the V8 flags server.js re-execs it with.
//
// On V8 13.6 (Node 24) that includes --no-wasm-code-gc: V8 13.6's process-wide
// wasm import wrapper cache can free a wrapper twice while wasm code GC runs
// and cart instances come and go, killing the server with "Check failed:
// jit_page.has_value()" or glibc heap corruption (2026-10-10, twice, during
// cartwheel WebGPU gates; reproduced after 65-76 cart loads on a private
// server). See the comment at the top of src/mcp/server.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "server.js");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test("the server process runs with the V8 flags it re-execs itself with", { timeout: 60000 }, async () => {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  delete env.ROMDEV_REEXEChild;
  const parent = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  try {
    const pid = await new Promise((resolve, reject) => {
      const onData = (d) => {
        out += d;
        const m = /server up pid=(\d+)/.exec(out);
        if (m) resolve(+m[1]);
      };
      parent.stdout.on("data", onData);
      parent.stderr.on("data", onData);
      parent.on("exit", (code, signal) => reject(new Error(`server exited (${code ?? signal}) before it was up:\n${out}`)));
    });
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    assert.ok(argv.includes("--experimental-vm-modules"), argv.join(" "));
    assert.equal(argv.includes("--no-wasm-code-gc"), process.versions.v8.startsWith("13.6."),
      `V8 ${process.versions.v8}: ${argv.join(" ")}`);
    process.kill(pid, "SIGTERM");
  } finally {
    parent.kill("SIGTERM");
  }
});
