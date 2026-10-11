#!/usr/bin/env node
// The permuter@home control server (upstream's Rust `pahserver`):
//   romdev-permuter-remote-controller run --listen-on IP:PORT --config config.toml --db db.json [--debug]
//   romdev-permuter-remote-controller setup --db db.json
import { run_controller, run_setup } from "../src/net/controller.js";
import { enable_debug_mode } from "../src/net/core.js";

const usage = `Usage: romdev-permuter-remote-controller <command> [<args>]

The permuter@home control server.

Commands:
  run               Run the permuter@home control server.
  setup             Setup initial database and config for permuter@home.`;

function die(msg) { process.stderr.write(msg + "\n"); process.exit(1); }

const [cmd, ...args] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--debug") opts.debug = true;
  else if (["--listen-on", "--config", "--db"].includes(a)) {
    if (i + 1 >= args.length) die(`Missing value for option '${a}'.`);
    opts[a.slice(2).replace("-", "_")] = args[++i];
  } else die(`Unrecognized argument: ${a}`);
}

if (cmd === "run") {
  for (const k of ["listen_on", "config", "db"]) if (!opts[k]) die(`Required options not provided:\n    --${k.replace("_", "-")}`);
  if (opts.debug) enable_debug_mode();
  const c = await run_controller({ listen_on: opts.listen_on, config: opts.config, db: opts.db, debug: opts.debug });
  process.stderr.write(`listening on ${c.address}\n`);
  const stop = async () => { await c.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else if (cmd === "setup") {
  if (!opts.db) die("Required options not provided:\n    --db");
  try {
    process.stdout.write((await run_setup(opts.db)) + "\n");
  } catch (e) {
    die(e.message);
  }
} else {
  process.stdout.write(usage + "\n");
  process.exit(cmd === "--help" || cmd === "-h" ? 0 : 1);
}
