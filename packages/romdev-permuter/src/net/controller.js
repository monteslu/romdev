// controller.js - the permuter@home control server, a port of
// decomp-permuter's Rust controller (src/net/controller/src/*.rs): accepts
// authenticated clients (-J permuters) and worker servers, schedules clients'
// seeds across servers by priority-weighted energy, relays results back, and
// keeps a JSON database of users and statistics.
import { readFileSync, renameSync, openSync, closeSync, fsyncSync, writeSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import sodium from "libsodium-wrappers";
import { Box, SigningKey, VerifyKey, SocketPort, StreamReader, nacl, pyJsonDumps, pyJsonLoads, EOFError } from "./core.js";
import { parseToml } from "../helpers.js";

export const HEARTBEAT_TIME_SEC = 300;
const SAVE_INTERVAL_MS = 30_000;
const MIN_PERMUTER_VERSION = 1;
const CLIENT_MAX_QUEUES_SIZE = 100;
const MIN_PRIORITY = 0.001;
const MAX_PRIORITY = 10.0;
const SERVER_WORK_QUEUE_SIZE = 100;
const TIME_US_GUESS = 100_000.0;
const MIN_OVERHEAD_US = 100_000.0;
const MAX_OVERHEAD_FACTOR = 2;

class ControllerError extends Error {}

// -- async primitives (tokio's Notify, mpsc, and the flimsy semaphore) ----------

/** tokio::sync::Notify: notify_waiters wakes current waiters; notify_one stores a permit. */
class Notify {
  constructor() { this.waiters = []; this.permit = false; }
  notified() {
    if (this.permit) { this.permit = false; return Promise.resolve(); }
    return new Promise((r) => this.waiters.push(r));
  }
  notify_waiters() { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
  notify_one() { if (this.waiters.length) this.waiters.shift()(); else this.permit = true; }
}

class Queue {
  constructor(capacity = Infinity) { this.items = []; this.waiters = []; this.cap = capacity; this.closed = false; }
  put(x) { if (this.waiters.length) this.waiters.shift()(x); else this.items.push(x); }
  /** try_send: false when full (the item is dropped). */
  try_put(x) { if (this.items.length >= this.cap) return false; this.put(x); return true; }
  get() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => this.waiters.push(r));
  }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w(null); }
  /** mpsc capacity(): free slots. */
  capacity() { return this.cap - this.items.length; }
}

/** An unfair semaphore that allows overdrafts (flimsy_semaphore.rs). */
class FlimsySemaphore {
  constructor(limit) { this.slots = limit; this.notify = new Notify(); }
  acquire_ignore_limit() { this.slots -= 1; }
  async acquire(isClosed) {
    while (this.slots <= 0) {
      await this.notify.notified();
      if (isClosed()) throw new EOFError("closed");
    }
    this.slots -= 1;
    if (this.slots > 0 && this.notify.waiters.length) this.notify.notify_one();
  }
  release() { if (this.slots++ === 0) this.notify.notify_one(); }
}

// -- database (db.rs, save.rs, stats.rs) ----------------------------------------

const newStats = () => [0, 0, 0, 0]; // [iterations, improvements, matches, functions]

export function emptyDb() { return { users: {}, func_stats: {}, total_stats: newStats() }; }

/** The JSON database, saved atomically (temp file + rename), batched every 30 s. */
export class SaveableDB {
  constructor(file, { saveIntervalMs = SAVE_INTERVAL_MS } = {}) {
    this.file = file;
    this.db = JSON.parse(readFileSync(file, "utf8"));
    this.saveIntervalMs = saveIntervalMs;
    this.timer = null;
    this.stale = false;
  }

  read(fn) { return fn(this.db); }

  async write(immediate, fn) {
    const ret = fn(this.db);
    if (immediate) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this._save();
    } else if (!this.stale) {
      this.stale = true;
      this.timer = setTimeout(() => { this.timer = null; this._save(); }, this.saveIntervalMs);
      this.timer.unref?.();
    }
    return ret;
  }

  _save() {
    this.stale = false;
    const dir = path.dirname(this.file);
    const tmp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.tmp`);
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(this.db));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.stale) this._save();
  }
}

function add_stats(stats, outcome) {
  if (outcome === "matched") stats[2] += 1;
  if (outcome === "matched" || outcome === "improved") stats[1] += 1;
  stats[0] += 1;
}

function func_stat(db, fn_name) {
  if (!Object.hasOwn(db.func_stats, fn_name)) db.func_stats[fn_name] = newStats();
  return db.func_stats[fn_name];
}

function log_stats(state, record) {
  state.db.write(false, (db) => {
    if (record.kind === "work_done") {
      add_stats(db.total_stats, record.outcome);
      add_stats(func_stat(db, record.fn_name), record.outcome);
      if (db.users[record.client]) add_stats(db.users[record.client].client_stats, record.outcome);
      if (db.users[record.server]) add_stats(db.users[record.server].server_stats, record.outcome);
    } else if (record.kind === "client_new_function") {
      func_stat(db, record.fn_name)[3] += 1;
      if (db.users[record.client]) db.users[record.client].client_stats[3] += 1;
      db.total_stats[3] += 1;
    } else if (record.kind === "server_new_function") {
      if (db.users[record.server]) db.users[record.server].server_stats[3] += 1;
    }
  });
}

// -- setup (setup.rs) ------------------------------------------------------------

/**
 * Create the database with a root user; returns the text to show (the server's
 * priv_seed for config.toml and the root client's pah.conf lines).
 */
export async function run_setup(dbFile) {
  await nacl();
  let fd;
  try {
    fd = openSync(dbFile, "wx");
  } catch (e) {
    throw new ControllerError(`Cannot create database file ${dbFile}: ${e.message}. Aborting.`);
  }
  const server_seed = sodium.randombytes_buf(32);
  const client_seed = sodium.randombytes_buf(32);
  const server = new SigningKey(server_seed);
  const client = new SigningKey(client_seed);
  const db = emptyDb();
  db.users[client.verify_key.hex()] = { trusted_by: null, name: "root", client_stats: newStats(), server_stats: newStats() };
  writeSync(fd, JSON.stringify(db));
  closeSync(fd);
  return "Setup successful!\n\n" +
    "Put the following in the server's config.toml:\n\n" +
    `priv_seed = "${server.hex()}"\n\n` +
    "Put the following in the root client's pah.conf:\n\n" +
    `secret_key = "${client.hex()}"\n` +
    `server_public_key = "${server.verify_key.hex()}"\n` +
    "server_address = \"server.example:port\"";
}

// -- handshake and requests (main.rs) ---------------------------------------------

async function handshake(sock, reader, sign_sk) {
  const buffer = await reader.readExact(4 + 32);
  if (buffer.subarray(0, 4).toString("latin1") !== "p@h0") throw new ControllerError("Invalid protocol version");
  const their_pk = buffer.subarray(4);
  const ours = sodium.crypto_box_keypair();
  const signature = sign_sk.sign(Buffer.concat([Buffer.from("HELLO:"), their_pk, Buffer.from(ours.publicKey)]));
  sock.write(Buffer.concat([Buffer.from(ours.publicKey), Buffer.from(signature)]));
  const port = new SocketPort(sock, reader, new Box(ours.privateKey, their_pk), "client", { is_client: false });
  const reply = await port.receive();
  if (reply.length !== 32 + 64 + 4) throw new ControllerError("Failed to perform secret handshake");
  const client_ver_key = new VerifyKey(reply.subarray(0, 32));
  const client_signature = reply.subarray(32, 96);
  const permuter_version = reply.readUInt32BE(96);
  if (!sodium.crypto_sign_verify_detached(client_signature, Buffer.concat([Buffer.from("WORLD:"), Buffer.from(ours.publicKey)]), client_ver_key.pk)) {
    throw new ControllerError("Spoofed client signature!");
  }
  return { port, user_id: client_ver_key.hex(), permuter_version };
}

function current_load(state, priority) {
  let servers = 0, cores = 0.0;
  for (const server of state.servers.values()) {
    if (priority == null || priority >= server.min_priority) { servers += 1; cores += server.num_cores; }
  }
  return { clients: state.permuters.size, servers, cores };
}

const send_error = (port, message) => port.send(Buffer.from(JSON.stringify(message)));
const send_json = (port, v) => port.send(Buffer.from(pyJsonDumps(v), "utf8"));
const recv_json = async (port) => pyJsonLoads((await port.receive()).toString("utf8"));

function num(obj, k) {
  if (typeof obj?.[k] !== "number") throw new ControllerError(`invalid type or missing field \`${k}\``);
  return obj[k];
}

async function handle_connection(sock, state, who) {
  const reader = new StreamReader(sock);
  const { port, user_id, permuter_version } = await handshake(sock, reader, state.sign_sk);
  const user = state.db.read((db) => db.users[user_id]);
  if (!user) {
    await send_error(port, "Access denied!");
    throw new ControllerError("Unknown client!");
  }
  const name = user.name;
  who.name = name;
  state.log(`[${name}] connected (v ${permuter_version})`);
  if (state.debug) port._who = name;
  await send_json(port, {});

  const request = await recv_json(port);
  switch (request?.method) {
    case "ping":
      state.log(`[${name}] ping`);
      await send_json(port, current_load(state, null));
      break;
    case "vouch":
      await handle_vouch(port, user_id, name, state, request);
      break;
    case "connect_server":
      await handle_connect_server(port, user_id, name, permuter_version, state, { min_priority: num(request, "min_priority"), num_cores: num(request, "num_cores") });
      break;
    case "connect_client":
      await handle_connect_client(port, user_id, name, permuter_version, state, { priority: num(request, "priority") });
      break;
    default:
      throw new ControllerError(`unknown variant \`${request?.method}\``);
  }
}

// -- vouch (vouch.rs) -------------------------------------------------------------

function parse_signed_name(signed_name, who) {
  if (typeof signed_name !== "string" || !/^([0-9a-fA-F]{2})*$/.test(signed_name)) throw new ControllerError("not a valid hex string");
  const data = Buffer.from(signed_name, "hex");
  if (data.length < 64) throw new ControllerError("signature too short");
  const sig = data.subarray(0, 64);
  const rest = data.subarray(64);
  if (!sodium.crypto_sign_verify_detached(sig, Buffer.concat([Buffer.from("NAME:"), rest]), Buffer.from(who, "hex"))) {
    throw new ControllerError("bad signature");
  }
  const name = new TextDecoder("utf-8", { fatal: true }).decode(rest);
  if (!name) throw new ControllerError("name is empty");
  if (/\p{Cc}/u.test(name)) throw new ControllerError("name cannot contain control characters");
  return name;
}

async function handle_vouch(port, who_id, who_name, state, data) {
  if (typeof data.who !== "string" || !/^[0-9a-fA-F]{64}$/.test(data.who)) throw new ControllerError("byte string has wrong size");
  const who = data.who.toLowerCase();
  let vouchee_name;
  try {
    vouchee_name = parse_signed_name(data.signed_name, who);
  } catch (e) {
    await send_error(port, e.message);
    throw e;
  }
  await send_json(port, {});
  await port.receive();
  await state.db.write(true, (db) => {
    if (!db.users[who]) db.users[who] = { trusted_by: who_id, name: vouchee_name, client_stats: newStats(), server_stats: newStats() };
  });
  await send_json(port, {});
  state.log(`[${who_name}] vouch ${vouchee_name}`);
}

// -- clients (client.rs) -----------------------------------------------------------

function send_result(perm, res) {
  perm.result_q.put(res);
  perm.semaphore.acquire_ignore_limit();
}

async function handle_connect_client(port, who_id, who_name, permuter_version, state, data) {
  if (permuter_version < MIN_PERMUTER_VERSION) throw new ControllerError("Permuter version too old!");
  if (!(MIN_PRIORITY <= data.priority && data.priority <= MAX_PRIORITY)) throw new ControllerError("Priority out of range");
  await send_json(port, current_load(state, data.priority));

  const permuter_data = await recv_json(port);
  if (typeof permuter_data?.fn_name !== "string") throw new ControllerError("missing field `fn_name`");
  const compressed_source = await port.receive();
  const compressed_target_o_bin = await port.receive();
  await send_json(port, {});
  state.log(`[${who_name}] start client (${permuter_data.fn_name}, ${data.priority})`);
  log_stats(state, { kind: "client_new_function", client: who_id, fn_name: permuter_data.fn_name });

  const fn_name = permuter_data.fn_name;
  const semaphore = new FlimsySemaphore(CLIENT_MAX_QUEUES_SIZE);
  const id = state.next_permuter_id++;
  const perm = {
    data: { json: permuter_data, compressed_source, compressed_target_o_bin },
    client_id: who_id,
    client_name: who_name,
    work_queue: [],
    result_q: new Queue(),
    semaphore,
    priority: data.priority,
    energy_add: 1.0 / data.priority,
  };
  state.permuters.set(id, perm);
  state.new_work_notification.notify_waiters();

  let closed = false;
  const isClosed = () => closed;
  const client_read = async () => {
    for (;;) {
      const msg = await recv_json(port);
      if (msg?.type !== "work" || msg.work == null || (typeof msg.work.seed !== "number" && typeof msg.work.seed !== "bigint")) {
        throw new ControllerError("invalid client message");
      }
      await semaphore.acquire(isClosed);
      if (perm.work_queue.length === 0) state.new_work_notification.notify_waiters();
      perm.work_queue.push({ seed: msg.work.seed });
    }
  };
  const client_write = async () => {
    for (;;) {
      const res = await perm.result_q.get();
      if (res == null) throw new EOFError("closed");
      semaphore.release();
      if (res.kind === "need_work") {
        await send_json(port, { type: "need_work" });
      } else {
        const { update } = res;
        const out = { server: res.server_name, type: update.type };
        if (update.type === "result") {
          out.has_source = update.has_source;
          Object.assign(out, update.more_props);
        } else if (update.type === "init_done") out.hash = update.hash;
        else if (update.type === "init_failed") out.reason = update.reason;
        await send_json(port, out);
        if (update.type === "result") {
          if (update.compressed_source != null) await port.send(update.compressed_source);
          const score = update.more_props.score;
          const outcome = update.compressed_source == null ? "unhelpful" : score === 0 ? "matched" : "improved";
          log_stats(state, { kind: "work_done", server: res.server_id, client: who_id, fn_name, outcome });
        }
      }
    }
  };
  try {
    await try_join([client_read(), client_write()]);
  } finally {
    closed = true;
    perm.result_q.close();
    semaphore.notify.notify_waiters();
    state.permuters.delete(id);
    state.new_work_notification.notify_waiters();
    port.close();
  }
}

/** tokio::try_join!: resolves when all do, rejects on the first failure. */
function try_join(promises) {
  return Promise.all(promises);
}

// -- servers (server.rs) -------------------------------------------------------------

function parse_update(u) {
  if (u == null || typeof u !== "object") throw new ControllerError("invalid update");
  switch (u.type) {
    case "result": {
      const { type: _t, overhead_us, has_source, ...more_props } = u;
      return { type: "result", overhead_us: typeof overhead_us === "number" ? Math.trunc(overhead_us) : 0, has_source: has_source === true, more_props, compressed_source: null };
    }
    case "init_done":
      if (typeof u.hash !== "string") throw new ControllerError("missing field `hash`");
      return { type: "init_done", hash: u.hash };
    case "init_failed":
      if (typeof u.reason !== "string") throw new ControllerError("missing field `reason`");
      return { type: "init_failed", reason: u.reason };
    case "disconnect":
      return { type: "disconnect" };
    default:
      throw new ControllerError(`unknown variant \`${u.type}\``);
  }
}

function try_next_work_message(state, ss) {
  const skip = new Set();
  for (;;) {
    for (const [perm_id, perm] of state.permuters) {
      if (!ss.jobs.has(perm_id)) {
        ss.jobs.set(perm_id, { state: "loading", energy: 0.0, active_work: 0 });
        return { permuter: perm_id, kind: "add", perm };
      }
    }
    let best_cost = 0.0;
    let best = null;
    for (const [perm_id, job] of ss.jobs) {
      const perm = state.permuters.get(perm_id);
      if (!perm) {
        ss.active_work -= job.active_work;
        ss.jobs.delete(perm_id);
        return { permuter: perm_id, kind: "remove" };
      }
      const energy = job.energy + job.active_work * perm.energy_add * TIME_US_GUESS;
      if (job.state === "loaded" && !skip.has(perm_id) && perm.priority >= ss.min_priority && (best == null || energy < best_cost)) {
        best_cost = energy;
        best = [perm_id, job];
      }
    }
    if (best == null) return null;
    const [perm_id, job] = best;
    const perm = state.permuters.get(perm_id);
    if (perm.work_queue.length === 0) {
      send_result(perm, { kind: "need_work" });
      skip.add(perm_id);
      continue;
    }
    const work = perm.work_queue.shift();
    perm.semaphore.release();
    const min_energy = job.energy;
    job.active_work += 1;
    ss.active_work += 1;
    for (const j of ss.jobs.values()) j.energy -= min_energy;
    return { permuter: perm_id, kind: "work", work };
  }
}

async function handle_connect_server(port, who_id, who_name, permuter_version, state, data) {
  if (permuter_version < MIN_PERMUTER_VERSION) throw new ControllerError("Permuter version too old!");
  state.log(`[${who_name}] start server (${data.min_priority}, ${data.num_cores})`);
  await send_json(port, { docker_image: state.docker_image, heartbeat_interval: state.heartbeat_sec });

  const more_work = new Queue(SERVER_WORK_QUEUE_SIZE);
  const writer_q = new Queue();
  const wrote_message = new Notify();
  const new_permuter = new Notify();
  const ss = { min_priority: data.min_priority, active_work: 0, more_work_acc: 0.0, jobs: new Map() };
  const server_key = Symbol(who_name);
  state.servers.set(server_key, { min_priority: data.min_priority, num_cores: data.num_cores, writer_q });
  let closed = false;
  const check = () => { if (closed) throw new EOFError("closed"); };

  const server_read = async () => {
    for (;;) {
      const msg = await recv_json(port);
      let update = null, perm_id = null, time_us = 0;
      if (msg?.type === "update") {
        if (!Number.isInteger(msg.permuter)) throw new ControllerError("invalid type: `permuter`");
        perm_id = msg.permuter;
        time_us = num(msg, "time_us");
        update = parse_update(msg.update);
        if (update.type === "result" && update.has_source) update.compressed_source = await port.receive();
      } else if (msg?.type !== "need_work") {
        throw new ControllerError(`unknown variant \`${msg?.type}\``);
      }
      let has_new = false;
      let more = 1.0;
      if (update) {
        const job = ss.jobs.get(perm_id);
        const perm = job ? state.permuters.get(perm_id) : null;
        if (job && perm) {
          job.energy += perm.energy_add * time_us;
          if (update.type === "init_done") {
            if (job.state !== "loading") throw new ControllerError("Got InitDone while not in Loading state");
            job.state = "loaded";
            has_new = true;
          } else if (update.type === "init_failed") {
            if (job.state !== "loading") throw new ControllerError("Got InitFailed while not in Loading state");
            job.state = "failed";
          } else if (update.type === "disconnect") {
            if (job.state !== "loaded") throw new ControllerError("Got Disconnect while not in Loaded state");
            job.state = "failed";
            ss.active_work -= job.active_work;
            job.active_work = 0;
            more = 0.0;
          } else {
            if (job.state !== "loaded") throw new ControllerError("Got result while not in Loaded state");
            job.active_work -= 1;
            ss.active_work -= 1;
            const min_overhead_us = Math.trunc(time_us + MIN_OVERHEAD_US);
            if (update.overhead_us === 0) {
              // Legacy server, skip this logic.
            } else if (update.overhead_us > MAX_OVERHEAD_FACTOR * min_overhead_us) more = 0.5;
            else if (update.overhead_us < min_overhead_us) more = 1.5;
          }
          send_result(perm, { kind: "result", server_id: who_id, server_name: who_name, update });
        }
      }
      more += ss.more_work_acc;
      let request_work = Math.trunc(more);
      ss.more_work_acc = more - request_work;
      if (request_work === 0 && ss.active_work === 0 && more_work.capacity() === SERVER_WORK_QUEUE_SIZE) request_work = 1;
      if (has_new) {
        new_permuter.notify_waiters();
        log_stats(state, { kind: "server_new_function", server: who_id });
      }
      for (let k = 0; k < request_work; k++) more_work.try_put(true);
    }
  };

  const next_work_message = async () => {
    for (;;) {
      check();
      const message = try_next_work_message(state, ss);
      if (message) return message;
      await Promise.race([state.new_work_notification.notified(), new_permuter.notified(), closedPromise]);
    }
  };

  let signalClosed;
  const closedPromise = new Promise((r) => { signalClosed = r; });

  const server_choose_work = async () => {
    for (;;) {
      const message = await next_work_message();
      check();
      const requires_response = message.kind !== "remove";
      writer_q.put(message);
      await Promise.race([wrote_message.notified(), closedPromise]);
      check();
      if (requires_response) {
        await more_work.get();
        check();
      }
    }
  };

  const server_write = async () => {
    for (;;) {
      const item = await writer_q.get();
      if (item == null) throw new EOFError("closed");
      if (item.kind === "heartbeat") {
        await send_json(port, { type: "heartbeat" });
        continue;
      }
      if (item.kind === "work") {
        await send_json(port, { permuter: item.permuter, type: "work", seed: item.work.seed });
      } else if (item.kind === "add") {
        await send_json(port, { permuter: item.permuter, type: "add", client_id: item.perm.client_id, client_name: item.perm.client_name, data: item.perm.data.json });
        await port.send(item.perm.data.compressed_source);
        await port.send(item.perm.data.compressed_target_o_bin);
      } else {
        await send_json(port, { permuter: item.permuter, type: "remove" });
      }
      wrote_message.notify_one();
    }
  };

  writer_q.put({ kind: "heartbeat" });
  const loops = [server_read(), server_choose_work(), server_write()];
  try {
    await Promise.race(loops.map((p) => p.then(() => { throw new ControllerError("loop exited"); })));
  } finally {
    closed = true;
    signalClosed();
    writer_q.close();
    more_work.close();
    port.close();
    for (const [perm_id, job] of ss.jobs) {
      if (job.state === "loaded") {
        const perm = state.permuters.get(perm_id);
        if (perm) send_result(perm, { kind: "result", server_id: who_id, server_name: who_name, update: { type: "disconnect" } });
      }
    }
    state.servers.delete(server_key);
    await Promise.allSettled(loops);
  }
}

// -- run (main.rs run_server) -----------------------------------------------------------

/**
 * Start the controller. Returns {address, close()}.
 * @param {{listen_on: string, config: string, db: string, debug?: boolean,
 *   heartbeat_sec?: number, log?: (s: string) => void, saveIntervalMs?: number}} opts
 */
export async function run_controller(opts) {
  await nacl();
  const config = parseToml(readFileSync(opts.config, "utf8"));
  if (typeof config.docker_image !== "string") throw new ControllerError("missing field `docker_image`");
  if (typeof config.priv_seed !== "string" || !/^[0-9a-fA-F]{64}$/.test(config.priv_seed)) throw new ControllerError("priv_seed: byte string has wrong size");
  const sign_sk = new SigningKey(Buffer.from(config.priv_seed, "hex"));
  const log = opts.log ?? ((s) => process.stderr.write(s + "\n"));
  const state = {
    docker_image: config.docker_image,
    debug: !!opts.debug,
    sign_sk,
    db: new SaveableDB(opts.db, { saveIntervalMs: opts.saveIntervalMs }),
    heartbeat_sec: opts.heartbeat_sec ?? HEARTBEAT_TIME_SEC,
    new_work_notification: new Notify(),
    servers: new Map(),
    permuters: new Map(),
    next_permuter_id: 0,
    log,
  };
  const sockets = new Set();
  const heartbeat = setInterval(() => {
    for (const s of state.servers.values()) s.writer_q.put({ kind: "heartbeat" });
  }, state.heartbeat_sec * 1000);
  heartbeat.unref?.();

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setNoDelay(true);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    const who = { name: "anonymous" };
    handle_connection(sock, state, who).catch((e) => {
      if (e instanceof EOFError || ["ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(e?.code)) log(`[${who.name}] disconnected`);
      else log(`[${who.name}] error: ${e?.message ?? e}`);
    }).finally(() => sock.destroy());
  });
  const idx = opts.listen_on.lastIndexOf(":");
  const host = opts.listen_on.slice(0, idx);
  const portNum = Number(opts.listen_on.slice(idx + 1));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(portNum, host.replace(/^\[|\]$/g, ""), resolve);
  });
  const addr = server.address();
  return {
    address: `${host}:${addr.port}`,
    port: addr.port,
    state,
    async close() {
      clearInterval(heartbeat);
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      state.db.flush();
    },
  };
}

export { ControllerError };
