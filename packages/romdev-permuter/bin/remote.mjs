#!/usr/bin/env node
// permuter@home CLI, a port of decomp-permuter's pah.py (src/net/cmd/):
//   romdev-permuter-remote [--debug] ping | setup | vouch MAGIC | run-server --cores N --memory GB [--systray] [--min-priority P]
// To use p@h as a client, pass -J to romdev-permuter; this is only needed for
// configuration or to run a worker server.
import { createInterface } from "node:readline/promises";
import { connect, read_config, write_config, enable_debug_mode, sign_with_magic, verify_with_magic, SigningKey, VerifyKey,
  sealedBoxEncrypt, sealedBoxDecrypt, EOFError, nacl, json_prop } from "../src/net/core.js";
import { Server, SystrayState, AsyncQueue, server_main_loop } from "../src/net/server.js";
import { ServerError } from "../src/error.js";
import { plural } from "../src/helpers.js";

const usage = `usage: romdev-permuter-remote [-h] [--debug] <command> ...

permuter@home - run the permuter across the Internet!

To use p@h as a client, just pass -J when running the permuter. This script is
only necessary for configuration or when running a worker server.

positional arguments:
  <command>
    ping      Check server connectivity.
    run-server
              Run a permuter worker server, allowing anyone with access to the
              central controller server to run permuter jobs on your machine.
    setup     Set up permuter@home. This will require someone else to grant you
              access to the central server.
    vouch     Give someone access to the central server.

options:
  -h, --help  show this help message and exit
  --debug     Enable debug logging.`;

const out = (s = "") => process.stdout.write(s + "\n");
let rl = null;
async function input(prompt) {
  rl ??= createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  process.stdout.write(prompt);
  const line = await rl.question("");
  return line;
}
async function ask(msg, { dflt }) {
  msg += dflt ? " (Y/n)? " : " (y/N)? ";
  const res = (await input(msg)).trim().toLowerCase();
  if (!res) return dflt;
  if (["y", "yes", "n", "no"].includes(res)) return res[0] === "y";
  out("Bad response!");
  process.exit(1);
}

async function run_ping() {
  const port = await connect();
  const t0 = performance.now();
  await port.send_json({ method: "ping" });
  const msg = await port.receive_json();
  const rtt = performance.now() - t0;
  out(`Connected successfully! Round-trip time: ${rtt.toFixed(1)} ms`);
  out(`${plural(json_prop(msg, "servers", "int"), "server")} online (${plural(Math.trunc(json_prop(msg, "cores", "float")), "core")}, ${plural(json_prop(msg, "clients", "int"), "client")})`);
  port.close();
}

function random_name() {
  let s = "";
  for (let i = 0; i < 5; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return s;
}

async function run_setup() {
  const config = await read_config();
  let signing_key = config.signing_key;
  if (!signing_key || !(await ask("Keep previous secret key", { dflt: true }))) {
    signing_key = SigningKey.generate();
    config.signing_key = signing_key;
    write_config(config);
  }
  let nickname = config.initial_setup_nickname;
  if (!nickname || !(await ask(`Keep previous nickname [${nickname}]`, { dflt: true }))) {
    const default_nickname = process.env.USER || random_name();
    nickname = (await input(`Nickname [default: ${default_nickname}]: `)) || default_nickname;
    config.initial_setup_nickname = nickname;
    write_config(config);
  }
  const signed_nickname = sign_with_magic("NAME", signing_key, Buffer.from(nickname, "utf8"));
  const vouch_text = Buffer.concat([Buffer.from(signing_key.verify_key.encode()), signed_nickname]).toString("base64");
  out("Ask someone to run the following command:");
  out(`romdev-permuter-remote vouch ${vouch_text}`);
  out();
  out("They should give you a token back in return. Paste that here:");
  const inp = (await input("")).trim();
  try {
    const data = Buffer.from(sealedBoxDecrypt(Buffer.from(inp, "base64"), signing_key.to_curve25519_private_key()));
    config.server_address = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(32));
    config.server_verify_key = new VerifyKey(data.subarray(0, 32));
    config.initial_setup_nickname = null;
  } catch {
    out("Invalid token!");
    process.exit(1);
  }
  out(`Server: ${config.server_address}`);
  out("Testing connection...");
  const port = await connect(config);
  await port.send_json({ method: "ping" });
  await port.receive_json();
  port.close();
  try {
    write_config(config);
  } catch (e) {
    out(`Failed to write config: ${e.message}`);
    process.exit(1);
  }
  out("permuter@home successfully set up!");
}

async function run_vouch(magic) {
  let verify_key, signed_nickname, nickname;
  try {
    const vouch_data = Buffer.from(magic, "base64");
    verify_key = new VerifyKey(vouch_data.subarray(0, 32));
    signed_nickname = vouch_data.subarray(32);
    nickname = new TextDecoder("utf-8", { fatal: true }).decode(verify_with_magic("NAME", verify_key, signed_nickname));
  } catch {
    out("Could not parse data!");
    process.exit(1);
  }
  let config, port;
  try {
    config = await read_config();
    port = await connect(config);
    await port.send_json({ method: "vouch", who: verify_key.hex(), signed_name: Buffer.from(signed_nickname).toString("hex") });
    await port.receive_json();
  } catch (e) {
    out(`Error: ${e.message}`);
    process.exit(1);
  }
  if (!(await ask(`Grant permuter server access to ${nickname}`, { dflt: true }))) { port.close(); return; }
  try {
    await port.send_json({});
    await port.receive_json();
  } catch (e) {
    out(`Failed to grant access: ${e.message}`);
    process.exit(1);
  }
  port.close();
  const data = Buffer.concat([Buffer.from(config.server_verify_key.encode()), Buffer.from(config.server_address, "utf8")]);
  const token = sealedBoxEncrypt(data, verify_key.to_curve25519_public_key());
  out("Granted!");
  out();
  out("Send them the following token:");
  out(Buffer.from(token).toString("base64"));
}

async function run_server(args) {
  const opts = { num_cores: null, max_memory_gb: null, systray: false, min_priority: 0.1 };
  const num = (v, flag) => {
    const x = Number(v);
    if (v == null || !Number.isFinite(x)) { process.stderr.write(`romdev-permuter-remote run-server: error: argument ${flag}: invalid float value: '${v}'\n`); process.exit(2); }
    return x;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--cores") opts.num_cores = num(args[++i], "--cores");
    else if (a === "--memory") opts.max_memory_gb = num(args[++i], "--memory");
    else if (a === "--systray") opts.systray = true;
    else if (a === "--min-priority") opts.min_priority = num(args[++i], "--min-priority");
    else { process.stderr.write(`romdev-permuter-remote run-server: error: unrecognized arguments: ${a}\n`); process.exit(2); }
  }
  const missing = [["--cores", opts.num_cores], ["--memory", opts.max_memory_gb]].filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length) { process.stderr.write(`romdev-permuter-remote run-server: error: the following arguments are required: ${missing.join(", ")}\n`); process.exit(2); }

  const io_queue = new AsyncQueue();
  const config = await read_config();
  let systray = new SystrayState();
  if (opts.systray) {
    const { RealSystrayState } = await import("../src/net/systray.js");
    try {
      systray = await RealSystrayState.create(io_queue);
    } catch (e) {
      out("Failed to initialize systray!");
      out();
      out(e.message);
      process.exit(1);
    }
  }
  const stop = () => io_queue.put([null, { kind: "shutdown" }]);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const server = new Server({ num_cores: opts.num_cores, max_memory_gb: opts.max_memory_gb, min_priority: opts.min_priority }, config, io_queue);
    await server.start();
    try {
      systray.server_connected();
      await server_main_loop(io_queue, server, systray);
    } finally {
      await server.stop();
    }
  } finally {
    await systray.stop();
  }
}

async function main() {
  await nacl();
  const argv = process.argv.slice(2);
  if (argv[0] === "--debug") { enable_debug_mode(); argv.shift(); }
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "ping") await run_ping();
    else if (cmd === "setup") await run_setup();
    else if (cmd === "vouch") {
      if (rest.length !== 1) { process.stderr.write("romdev-permuter-remote vouch: error: the following arguments are required: magic\n"); process.exit(2); }
      await run_vouch(rest[0]);
    } else if (cmd === "run-server") await run_server(rest);
    else if (cmd === undefined || cmd === "-h" || cmd === "--help") out(usage);
    else { process.stderr.write(`${usage}\nromdev-permuter-remote: error: argument <command>: invalid choice: '${cmd}'\n`); process.exit(2); }
  } catch (e) {
    if (e instanceof EOFError) { out(`Network error: ${e.message}`); process.exit(1); }
    if (e instanceof ServerError) { out(`Error: ${e.message}`); process.exit(1); }
    throw e;
  } finally {
    rl?.close();
  }
  process.exit(0);
}

main();
