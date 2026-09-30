// server.js - a permuter@home worker server, a port of decomp-permuter's
// src/net/server.py: connect to the controller as a server, start the
// evaluator (evaluator.js, a separate node process instead of upstream's
// Docker container), and shuttle jobs, seeds and results between them.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inflateSync } from "node:zlib";
import sodium from "libsodium-wrappers";
import { FilePort, SecretBox, connect, nacl, json_prop, permuter_data_from_json, permuter_data_to_json, CancelToken, EOFError } from "./core.js";
import { get_default_randomization_weights, merge_randomization_weights } from "../helpers.js";
import { ServerError } from "../error.js";

const HEARTBEAT_INTERVAL_SLACK_SEC = 50.0;
const EVALUATOR = fileURLToPath(new URL("./evaluator.js", import.meta.url));

/** An async FIFO. */
export class AsyncQueue {
  constructor() { this.items = []; this.waiters = []; }
  put(x) { if (this.waiters.length) this.waiters.shift()(x); else this.items.push(x); }
  get() { return this.items.length ? Promise.resolve(this.items.shift()) : new Promise((r) => this.waiters.push(r)); }
}

/**
 * The evaluator child, as upstream's DockerPort: a SecretBox-encrypted pipe
 * over its stdin/stdout. `num_cores` bounds its worker threads and
 * `max_memory_gb` its heap (node --max-old-space-size).
 */
class EvaluatorPort extends FilePort {
  constructor(child, secret) {
    super(child.stdout, child.stdin, new SecretBox(secret), "evaluator", { is_client: true });
    this._child = child;
    this._closed = false;
  }

  shutdown() {
    if (this._closed) return;
    this._closed = true;
    try { this._child.stdin.end(); } catch { /* gone */ }
    try { this._child.kill("SIGKILL"); } catch { /* gone */ }
  }
}

export async function _start_evaluator(image, options, log = (s) => process.stdout.write(s + "\n")) {
  log("Starting evaluator...");
  await nacl();
  const secret = sodium.randombytes_buf(32);
  const child = spawn(process.execPath, [`--max-old-space-size=${Math.max(256, Math.floor(options.max_memory_gb * 1024))}`, EVALUATOR], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SECRET: Buffer.from(secret).toString("base64"), PAH_IMAGE: image, PAH_WORKDIR: options.workdir ?? path.join(process.cwd(), ".pah-work") },
  });
  child.stderr.on("data", (d) => process.stderr.write(Buffer.concat([Buffer.from("Evaluator stderr: "), d])));
  const port = new EvaluatorPort(child, secret);
  try {
    const magic = Buffer.alloc(1000);
    await port.send(magic);
    const r = await port.receive();
    if (!r.equals(magic)) throw new Error("Failed initial sanity check.");
    await port.send_json({ num_cores: options.num_cores });
  } catch (e) {
    port.shutdown();
    throw e;
  }
  log("Started.");
  return port;
}

/** One connected session: controller <-> this server <-> evaluator (ServerInner + NetThread). */
class ServerInner {
  constructor(net_port, evaluator_port, io_queue, heartbeat_interval) {
    this._net = net_port;
    this._eval = evaluator_port;
    this._io_queue = io_queue;
    this._active = new Set();
    this._time_starts = new Map();
    this._token = new CancelToken();
    this._handles = new Map();
    this._next_work_id = 0;
    this._main = new AsyncQueue();
    this._out = new AsyncQueue();
    this._heartbeat_interval = heartbeat_interval;
    this._last_heartbeat = Date.now() / 1000;
    this._stopped = false;
    this._loops = [this._read_loop(), this._write_loop(), this._read_eval_loop(), this._main_loop(), this._heartbeat_loop()];
  }

  /** PermuterHandle: (id, token), one stable object per id per session so it can key a Map. */
  _handle_obj(handle) {
    if (!this._handles.has(handle)) this._handles.set(handle, [handle, this._token]);
    return this._handles.get(handle);
  }

  _send_io(handle, msg) { this._io_queue.put([this._token, [this._handle_obj(handle), msg]]); }

  _send_io_global(msg) { this._io_queue.put([this._token, msg]); }

  // -- controller reader (NetThread.read_loop) --
  async _read_one() {
    const msg = await this._net.receive_json();
    const time_start = Date.now() / 1000;
    const msg_type = json_prop(msg, "type", "string");
    if (msg_type === "heartbeat") return { kind: "heartbeat" };
    const handle = json_prop(msg, "permuter", "int");
    if (msg_type === "work") {
      const seed = json_prop(msg, "seed", "int");
      return { kind: "work", handle, id: this._next_work_id++, time_start, seed };
    }
    if (msg_type === "add") {
      const client = { id: json_prop(msg, "client_id", "string"), nickname: json_prop(msg, "client_name", "string") };
      const data = json_prop(msg, "data", "dict");
      const compressed_source = await this._net.receive();
      const compressed_target_o_bin = await this._net.receive();
      let permuter;
      try {
        permuter = permuter_data_from_json(data, inflateSync(compressed_source).toString("utf8"), inflateSync(compressed_target_o_bin));
      } catch (e) {
        return { kind: "immediate_disconnect", handle, client, reason: `Failed to parse permuter: ${e.message || e.name}` };
      }
      permuter.randomization_weights = merge_randomization_weights(get_default_randomization_weights("base"), permuter.randomization_weights);
      return { kind: "add", handle, time_start, client, permuter_data: permuter };
    }
    if (msg_type === "remove") return { kind: "remove", handle };
    throw new Error(`Bad message type: ${msg_type}`);
  }

  async _read_loop() {
    try {
      for (;;) this._main.put(await this._read_one());
    } catch (e) {
      if (e instanceof EOFError) this._main.put({ kind: "net_disconnected", graceful: true });
      else if (e instanceof ServerError) this._main.put({ kind: "net_disconnected", graceful: false, message: e.message });
      else {
        if (!this._stopped) process.stderr.write(String(e.stack ?? e) + "\n");
        this._main.put({ kind: "net_disconnected", graceful: false });
      }
    }
  }

  // -- controller writer (NetThread.write_loop) --
  async _write_loop() {
    try {
      for (;;) {
        const item = await this._out.get();
        if (item.kind === "shutdown") break;
        if (item.kind === "init_fail") {
          await this._net.send_json({ type: "update", permuter: item.handle, time_us: 0, update: { type: "init_failed", reason: item.error } });
        } else if (item.kind === "init_success") {
          await this._net.send_json({ type: "update", permuter: item.handle, time_us: item.time_us, update: { type: "init_done", hash: item.base_hash } });
        } else if (item.kind === "disconnect") {
          await this._net.send_json({ type: "update", permuter: item.handle, time_us: 0, update: { type: "disconnect" } });
        } else if (item.kind === "need_work") {
          await this._net.send_json({ type: "need_work" });
        } else if (item.kind === "work") {
          const overhead_us = Math.trunc((Date.now() / 1000 - item.time_start) * 1e6) - item.time_us;
          await this._net.send_json({ type: "update", permuter: item.handle, time_us: item.time_us, update: { type: "work", overhead_us, ...item.obj } });
          if (item.compressed_source != null) await this._net.send(item.compressed_source);
        }
      }
    } catch (e) {
      if (e instanceof EOFError) this._main.put({ kind: "net_disconnected", graceful: true });
      else {
        if (!this._stopped) process.stderr.write(String(e.stack ?? e) + "\n");
        this._main.put({ kind: "net_disconnected", graceful: false });
      }
    }
  }

  // -- evaluator reader --
  async _read_eval_loop() {
    try {
      for (;;) {
        const msg = await this._eval.receive_json();
        const msg_type = json_prop(msg, "type", "string");
        if (msg_type === "init") {
          const perm_id = json_prop(msg, "permuter", "string");
          const time_us = json_prop(msg, "time_us", "int");
          if (json_prop(msg, "success", "boolean")) {
            this._main.put({ kind: "perm_init_success", perm_id, base_score: json_prop(msg, "base_score", "int"), base_hash: json_prop(msg, "base_hash", "string"), time_us });
          } else {
            this._main.put({ kind: "perm_init_fail", perm_id, error: json_prop(msg, "error", "string") });
          }
        } else if (msg_type === "result") {
          let compressed_source = null;
          if (msg.has_source === true) compressed_source = await this._eval.receive();
          const perm_id = json_prop(msg, "permuter", "string");
          const id = json_prop(msg, "id", "int");
          const time_us = json_prop(msg, "time_us", "int");
          delete msg.permuter; delete msg.id; delete msg.time_us;
          this._main.put({ kind: "work_done", perm_id, id, obj: msg, time_us, compressed_source });
        } else {
          throw new Error(`Unknown message type from evaluator: ${msg_type}`);
        }
      }
    } catch (e) {
      if (!(e instanceof EOFError) && !this._stopped) process.stderr.write(String(e.stack ?? e) + "\n");
    }
  }

  _need_work() { this._out.put({ kind: "need_work" }); }

  async _remove(handle) {
    await this._eval.send_json({ type: "remove", permuter: String(handle) });
    this._active.delete(handle);
  }

  async _handle(msg) {
    switch (msg.kind) {
      case "heartbeat":
        this._last_heartbeat = Date.now() / 1000;
        break;
      case "work":
        if (!this._active.has(msg.handle)) { this._need_work(); return; }
        this._time_starts.set(msg.id, msg.time_start);
        await this._eval.send_json({ type: "work", permuter: String(msg.handle), id: msg.id, seed: msg.seed });
        break;
      case "add": {
        if (this._active.has(msg.handle)) throw new Error("Repeated AddPermuter!");
        this._active.add(msg.handle);
        const perm = msg.permuter_data;
        await this._eval.send_json({ type: "add", permuter: String(msg.handle), ...permuter_data_to_json(perm) });
        await this._eval.send(Buffer.from(perm.source, "utf8"));
        await this._eval.send(perm.target_o_bin);
        this._send_io(msg.handle, { kind: "connect", fn_name: perm.fn_name, client: msg.client });
        break;
      }
      case "remove":
        if (!this._active.has(msg.handle)) return;
        await this._remove(msg.handle);
        this._send_io(msg.handle, { kind: "disconnect", reason: "disconnected" });
        break;
      case "user_disconnect":
        if (!this._active.has(msg.handle)) return;
        await this._remove(msg.handle);
        this._send_io(msg.handle, { kind: "disconnect", reason: "kicked" });
        this._out.put({ kind: "disconnect", handle: msg.handle });
        break;
      case "immediate_disconnect":
        if (this._active.has(msg.handle)) throw new Error("ImmediateDisconnect is not immediate");
        this._send_io(msg.handle, { kind: "immediate_disconnect", reason: msg.reason, client: msg.client });
        this._out.put({ kind: "init_fail", handle: msg.handle, error: msg.reason });
        break;
      case "perm_init_fail": {
        const handle = Number(msg.perm_id);
        if (!this._active.has(handle)) { this._need_work(); return; }
        this._active.delete(handle);
        this._send_io(handle, { kind: "disconnect", reason: "failed to compile" });
        this._out.put({ kind: "init_fail", handle, error: msg.error });
        break;
      }
      case "perm_init_success": {
        const handle = Number(msg.perm_id);
        if (!this._active.has(handle)) { this._need_work(); return; }
        this._out.put({ kind: "init_success", handle, time_us: msg.time_us, base_score: msg.base_score, base_hash: msg.base_hash });
        break;
      }
      case "work_done": {
        const handle = Number(msg.perm_id);
        const time_start = this._time_starts.get(msg.id);
        this._time_starts.delete(msg.id);
        if (!this._active.has(handle)) { this._need_work(); return; }
        const obj = msg.obj;
        obj.permuter = handle;
        const score = "score" in obj ? json_prop(obj, "score", "int") : null;
        const is_improvement = msg.compressed_source != null;
        this._send_io(handle, { kind: "work_done", score, is_improvement });
        this._out.put({ kind: "work", handle, time_start, time_us: msg.time_us, obj, compressed_source: msg.compressed_source });
        break;
      }
      case "net_disconnected":
        this._send_io_global({ kind: "server_failed", graceful: msg.graceful, message: msg.message ?? null });
        break;
      default:
        throw new Error(`unreachable ${msg.kind}`);
    }
  }

  async _main_loop() {
    for (;;) {
      const msg = await this._main.get();
      if (msg.kind === "shutdown") break;
      try { await this._handle(msg); } catch (e) {
        if (!this._stopped) process.stderr.write(String(e.stack ?? e) + "\n");
        this._send_io_global({ kind: "server_failed", graceful: false, message: String(e.message) });
      }
    }
  }

  async _heartbeat_loop() {
    let second_attempt = false;
    while (!this._stopped) {
      const delay = this._last_heartbeat + this._heartbeat_interval + HEARTBEAT_INTERVAL_SLACK_SEC / 2 - Date.now() / 1000;
      if (delay <= 0) {
        if (second_attempt) { this._main.put({ kind: "net_disconnected", graceful: true }); return; }
        second_attempt = true;
        await this._sleep(HEARTBEAT_INTERVAL_SLACK_SEC / 2);
      } else {
        second_attempt = false;
        await this._sleep(delay);
      }
    }
  }

  _sleep(sec) {
    return new Promise((r) => {
      const t = setTimeout(r, sec * 1000);
      t.unref?.();
      this._wakeSleep = () => { clearTimeout(t); r(); };
    });
  }

  remove_permuter(handle) { this._main.put({ kind: "user_disconnect", handle }); }

  async stop() {
    this._token.cancelled = true;
    this._stopped = true;
    this._main.put({ kind: "shutdown" });
    this._out.put({ kind: "shutdown" });
    this._wakeSleep?.();
    this._net.shutdown();
    this._net.close();
    this._eval.shutdown();
    await Promise.allSettled(this._loops);
  }
}

/** A server that may or may not be connected to the controller and the evaluator. */
export class Server {
  /**
   * @param {{num_cores: number, max_memory_gb: number, min_priority: number, workdir?: string}} options
   */
  constructor(options, config, io_queue) {
    this._server = null;
    this._options = options;
    this._config = config;
    this._io_queue = io_queue;
  }

  async start() {
    if (this._server) throw new Error("AssertionError: already started");
    const net_port = await connect(this._config);
    await net_port.send_json({ method: "connect_server", min_priority: this._options.min_priority, num_cores: this._options.num_cores });
    const obj = await net_port.receive_json();
    const image = json_prop(obj, "docker_image", "string");
    const heartbeat_interval = json_prop(obj, "heartbeat_interval", "float");
    const evaluator_port = await _start_evaluator(image, this._options);
    try {
      this._server = new ServerInner(net_port, evaluator_port, this._io_queue, heartbeat_interval);
    } catch (e) {
      evaluator_port.shutdown();
      throw e;
    }
  }

  async stop() {
    if (!this._server) return;
    await this._server.stop();
    this._server = null;
  }

  remove_permuter(handle) {
    if (this._server && !handle[1].cancelled) this._server.remove_permuter(handle[0]);
  }
}

/** The Reconnector of run_server.py. */
export class Reconnector {
  constructor(io_queue, random = Math.random) {
    this._io_queue = io_queue;
    this._random = random;
    this._token = new CancelToken();
    this._delay = 5.0;
    this._timer = null;
    this._start = this._stop = Date.now() / 1000;
  }

  mark_start() { this._start = Date.now() / 1000; }

  mark_stop() { this._stop = Date.now() / 1000; }

  stop() {
    this._token.cancelled = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  reconnect_eventually() {
    let delay;
    if (this._stop - this._start > 60.0) delay = this._delay = 5.0;
    else {
      delay = this._delay;
      this._delay = this._delay * 2.0 + (1.0 + (60.0 - 1.0) * this._random());
    }
    const token = new CancelToken();
    this._token = token;
    this._timer = setTimeout(() => this._io_queue.put([token, { kind: "reconnect" }]), delay * 1000);
    return Math.trunc(delay);
  }
}

/** run_server.main_loop: print connections/disconnections, reconnect with backoff. */
export async function server_main_loop(io_queue, server, systray, log = (s) => process.stdout.write(s + "\n")) {
  const reconnector = new Reconnector(io_queue);
  const handle_clients = new Map();
  for (;;) {
    const [token, activity] = await io_queue.get();
    if (token && token.cancelled) continue;
    if (!Array.isArray(activity)) {
      if (activity.kind === "shutdown") break;
      if (activity.kind === "reconnect") {
        log("reconnecting...");
        try {
          systray.server_reconnecting();
          reconnector.mark_start();
          await server.start();
          systray.server_connected();
        } catch (e) {
          if (e instanceof EOFError) {
            const delay = reconnector.reconnect_eventually();
            log(`failed again, reconnecting in ${delay} seconds...`);
            systray.server_failed(true);
          } else if (e instanceof ServerError) {
            log(`failed! ${e.message}`);
            systray.server_failed(false, e.message);
          } else {
            log("failed!");
            process.stderr.write(String(e.stack ?? e) + "\n");
            systray.server_failed(false);
          }
        }
      } else if (activity.kind === "server_failed") {
        if (activity.message) log(`Server error: ${activity.message}`);
        log("disconnected from permuter@home");
        await server.stop();
        reconnector.mark_stop();
        systray.server_failed(activity.graceful, activity.message);
        if (activity.graceful) log(`will reconnect in ${reconnector.reconnect_eventually()} seconds...`);
      }
      continue;
    }
    const [handle, msg] = activity;
    if (msg.kind === "connect") {
      handle_clients.set(handle, msg.client);
      systray.connect(handle, msg.client.nickname, msg.fn_name);
      log(`[${msg.client.nickname}] connected (${msg.fn_name})`);
    } else if (msg.kind === "disconnect") {
      systray.disconnect(handle);
      const nickname = handle_clients.get(handle)?.nickname;
      handle_clients.delete(handle);
      log(`[${nickname}] ${msg.reason}`);
    } else if (msg.kind === "immediate_disconnect") {
      log(`[${msg.client.nickname}] ${msg.reason}`);
    } else if (msg.kind === "work_done") {
      systray.work_done(handle, msg.is_improvement);
    } else if (msg.kind === "user_remove") {
      server.remove_permuter(handle);
    }
  }
  reconnector.stop();
}

/** A systray state that does nothing (run-server without --systray). */
export class SystrayState {
  server_reconnecting() {}
  server_connected() {}
  server_failed() {}
  connect() {}
  disconnect() {}
  work_done() {}
  stop() {}
}
