// core.js - permuter@home's wire protocol and configuration, a port of
// decomp-permuter's src/net/core.py (and the matching half of the Rust
// controller's port.rs). Crypto is libsodium (libsodium.js, WASM), the same
// primitives PyNaCl / sodiumoxide use:
//   handshake   X25519 ephemeral keys, Ed25519 signatures ("HELLO:", "WORLD:")
//   messages    8-byte big-endian length + crypto_box (xsalsa20-poly1305)
//               with counter nonces (16 zero bytes + u64 BE; client even,
//               server odd), or crypto_secretbox for the evaluator pipe
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import sodium from "libsodium-wrappers";
import { parseToml } from "../helpers.js";
import { ServerError } from "../error.js";

export const PERMUTER_VERSION = 2;
export const CONFIG_FILENAME = "pah.conf";

let DEBUG_MODE = false;
export function enable_debug_mode() { DEBUG_MODE = true; }
export function debug_print(message) {
  if (DEBUG_MODE) {
    const d = new Date();
    const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}:${String(d.getMilliseconds() * 1000).padStart(6, "0")}`;
    process.stdout.write(`\n${t} debug: ${message}\n`);
  }
}

/** libsodium, initialised. */
export async function nacl() {
  await sodium.ready;
  return sodium;
}

export class EOFError extends Error {
  constructor(message = "EOF") { super(message); this.name = "EOFError"; }
}

export class CancelToken {
  constructor() { this.cancelled = false; }
}

// -- keys --------------------------------------------------------------------

export class SigningKey {
  /** @param {Uint8Array} seed 32 bytes (what pah.conf stores as secret_key) */
  constructor(seed) {
    if (seed.length !== 32) throw new Error("The seed must be exactly 32 bytes long");
    const kp = sodium.crypto_sign_seed_keypair(seed);
    this.seed = Uint8Array.from(seed);
    this.sk = kp.privateKey;
    this.verify_key = new VerifyKey(kp.publicKey);
  }

  static generate() { return new SigningKey(sodium.randombytes_buf(32)); }

  /** Detached Ed25519 signature (64 bytes). */
  sign(msg) { return sodium.crypto_sign_detached(msg, this.sk); }

  to_curve25519_private_key() { return sodium.crypto_sign_ed25519_sk_to_curve25519(this.sk); }

  hex() { return Buffer.from(this.seed).toString("hex"); }
}

export class VerifyKey {
  constructor(pk) {
    if (pk.length !== 32) throw new Error("The key must be exactly 32 bytes long");
    this.pk = Uint8Array.from(pk);
  }

  verify(msg, signature) {
    if (!sodium.crypto_sign_verify_detached(signature, msg, this.pk)) throw new Error("Signature was forged or corrupt");
    return msg;
  }

  to_curve25519_public_key() { return sodium.crypto_sign_ed25519_pk_to_curve25519(this.pk); }

  encode() { return this.pk; }

  hex() { return Buffer.from(this.pk).toString("hex"); }
}

/** A crypto_box between two X25519 keys (precomputed). */
export class Box {
  constructor(privateKey, publicKey) { this.k = sodium.crypto_box_beforenm(publicKey, privateKey); }
  encrypt(msg, nonce) { return sodium.crypto_box_easy_afternm(msg, nonce, this.k); }
  decrypt(ct, nonce) { return sodium.crypto_box_open_easy_afternm(ct, nonce, this.k); }
}

export class SecretBox {
  constructor(key) { this.k = Uint8Array.from(key); }
  encrypt(msg, nonce) { return sodium.crypto_secretbox_easy(msg, nonce, this.k); }
  decrypt(ct, nonce) { return sodium.crypto_secretbox_open_easy(ct, nonce, this.k); }
}

export const sealedBoxEncrypt = (msg, curvePk) => sodium.crypto_box_seal(msg, curvePk);
export function sealedBoxDecrypt(ct, curveSk) {
  const pk = sodium.crypto_scalarmult_base(curveSk);
  return sodium.crypto_box_seal_open(ct, pk, curveSk);
}

const concat = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
const enc = (s) => Buffer.from(s, "utf8");

export function sign_with_magic(magic, signing_key, data) {
  const signature = signing_key.sign(concat(magic, enc(":"), data));
  return concat(signature, data);
}

export function verify_with_magic(magic, verify_key, data) {
  if (data.length < 64) throw new Error("String is too small to contain a signature");
  const signature = data.subarray(0, 64);
  const rest = data.subarray(64);
  verify_key.verify(concat(magic, enc(":"), rest), signature);
  return rest;
}

// -- permuter data -------------------------------------------------------------

/** json_prop with Python's typing: ints are integral JSON numbers, floats accept ints. */
function prop(obj, key, type, dflt) {
  if (!(key in obj)) {
    if (dflt !== undefined) return dflt;
    throw new Error(`Member ${key} does not exist`);
  }
  const v = obj[key];
  const ok = type === "int" ? Number.isInteger(v) || typeof v === "bigint" : type === "float" ? typeof v === "number" : type === "dict"
    ? v != null && typeof v === "object" && !Array.isArray(v) : typeof v === type;
  if (!ok) throw new Error(`Member ${key} must have type ${type === "string" ? "str" : type}`);
  return v;
}
export { prop as json_prop };

export function permuter_data_from_json(obj, source, target_o_bin) {
  return {
    base_score: prop(obj, "base_score", "int"),
    base_hash: prop(obj, "base_hash", "string"),
    fn_name: prop(obj, "fn_name", "string"),
    filename: prop(obj, "filename", "string"),
    keep_prob: prop(obj, "keep_prob", "float"),
    need_profiler: prop(obj, "need_profiler", "boolean"),
    stack_differences: prop(obj, "stack_differences", "boolean"),
    algorithm: prop(obj, "algorithm", "string"),
    compile_script: prop(obj, "compile_script", "string"),
    randomization_weights: Object.fromEntries(Object.entries(prop(obj, "randomization_weights", "dict", {})).map(([k, v]) => {
      if (typeof v !== "number") throw new Error("Dict entries must have type float");
      return [k, v];
    })),
    source,
    target_o_bin,
    ign_branch_targets: prop(obj, "ign_branch_targets", "boolean", true),
    objdump_command: prop(obj, "objdump_command", "string", ""),
  };
}

export function permuter_data_to_json(perm) {
  return {
    base_score: perm.base_score,
    base_hash: perm.base_hash,
    fn_name: perm.fn_name,
    filename: perm.filename,
    keep_prob: perm.keep_prob,
    need_profiler: perm.need_profiler,
    stack_differences: perm.stack_differences,
    algorithm: perm.algorithm,
    randomization_weights: perm.randomization_weights,
    compile_script: perm.compile_script,
    ign_branch_targets: perm.ign_branch_targets,
    objdump_command: perm.objdump_command,
  };
}

/**
 * JSON as Python's json.dumps writes it (", " / ": " separators, ASCII-only),
 * so float fields keep a decimal point: a JS float that is integral prints as
 * `1.0`, which the Rust controller and the Python peers both read as a float.
 */
export function pyJsonDumps(v, floatKeys = FLOAT_KEYS) {
  const esc = (s) => JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const num = (x, isFloat) => {
    if (!Number.isFinite(x)) return x > 0 ? "Infinity" : x < 0 ? "-Infinity" : "NaN";
    if (isFloat && Number.isInteger(x)) return x.toFixed(1);
    if (isFloat) {
      const s = String(x);
      return /e/.test(s) ? s.replace(/e([+-])(\d)$/, "e$10$2") : s;
    }
    return String(x);
  };
  const walk = (x, key, parentFloatDict) => {
    if (x === null || x === undefined) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "number") return num(x, parentFloatDict || floatKeys.has(key));
    if (typeof x === "bigint") return x.toString();
    if (typeof x === "string") return esc(x);
    if (Array.isArray(x)) return "[" + x.map((e) => walk(e, null, false)).join(", ") + "]";
    const floatDict = key === "randomization_weights" || key === "profiler";
    return "{" + Object.entries(x).map(([k, e]) => `${esc(k)}: ${walk(e, k, floatDict)}`).join(", ") + "}";
  };
  return walk(v, null, false);
}
const FLOAT_KEYS = new Set(["keep_prob", "priority", "min_priority", "num_cores", "cores", "heartbeat_interval"]);

/**
 * JSON.parse that keeps integers beyond 2**53 exact (as BigInt), like Python's
 * json and serde_json do for u64 seeds.
 */
export function pyJsonLoads(text) {
  return JSON.parse(text, (_k, v, ctx) => (typeof v === "number" && !Number.isSafeInteger(v) && ctx?.source && /^-?\d+$/.test(ctx.source) ? BigInt(ctx.source) : v));
}

// -- config ------------------------------------------------------------------

export class Config {
  constructor() {
    this.server_address = null;
    /** @type {VerifyKey|null} */
    this.server_verify_key = null;
    /** @type {SigningKey|null} */
    this.signing_key = null;
    this.initial_setup_nickname = null;
  }
}

export async function read_config(file = CONFIG_FILENAME) {
  await nacl();
  const config = new Config();
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return config;
    throw e;
  }
  try {
    const obj = parseToml(text);
    const str = (k) => (typeof obj[k] === "string" ? obj[k] : null);
    if (str("server_public_key")) config.server_verify_key = new VerifyKey(Buffer.from(str("server_public_key"), "hex"));
    if (str("secret_key")) config.signing_key = new SigningKey(Buffer.from(str("secret_key"), "hex"));
    config.initial_setup_nickname = str("initial_setup_nickname");
    config.server_address = str("server_address");
  } catch (e) {
    process.stdout.write(`Malformed configuration file ${file}.\n\n`);
    throw e;
  }
  return config;
}

/** toml.dump of pah.conf's flat string table. */
export function write_config(config, file = CONFIG_FILENAME) {
  const obj = [];
  const write = (k, v) => { if (v != null) obj.push([k, v]); };
  write("initial_setup_nickname", config.initial_setup_nickname);
  write("server_address", config.server_address);
  if (config.server_verify_key) write("server_public_key", config.server_verify_key.hex());
  if (config.signing_key) write("secret_key", config.signing_key.hex());
  writeFileSync(file, obj.map(([k, v]) => `${k} = ${JSON.stringify(v)}\n`).join(""));
}

// -- byte streams ----------------------------------------------------------------

/** Promise-based exact reads from a Readable (net.Socket, process.stdin, a child's stdout). */
export class StreamReader {
  constructor(stream) {
    this.chunks = [];
    this.len = 0;
    this.ended = false;
    this.error = null;
    this.waiter = null;
    stream.on("data", (d) => { this.chunks.push(d); this.len += d.length; this._wake(); });
    stream.on("end", () => { this.ended = true; this._wake(); });
    stream.on("close", () => { this.ended = true; this._wake(); });
    stream.on("error", (e) => { this.error = e; this.ended = true; this._wake(); });
  }

  _wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }

  _take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.len = rest.length;
    return Buffer.from(out);
  }

  async readExact(n) {
    while (this.len < n) {
      if (this.ended) throw new EOFError(this.error ? String(this.error.message) : "EOF");
      await new Promise((r) => { this.waiter = r; });
    }
    return this._take(n);
  }

  /** Whatever is buffered, up to n bytes (socket_read_max's error-context use). */
  async readMax(n) {
    if (!this.len && !this.ended) await new Promise((r) => { this.waiter = r; setTimeout(r, 100).unref?.(); });
    return this._take(Math.min(n, this.len));
  }
}

function nonceFor(n) {
  const b = Buffer.alloc(24);
  b.writeBigUInt64BE(BigInt(n), 16);
  return b;
}

/** An encrypted, length-framed message channel (core.Port). */
export class Port {
  constructor(box, who, { is_client }) {
    this._box = box;
    this._who = who;
    this._send_nonce = is_client ? 0 : 1;
    this._receive_nonce = is_client ? 1 : 0;
  }

  async send(msg) {
    msg = Buffer.from(msg);
    if (DEBUG_MODE) debug_print(msg.length <= 300 ? `Send to ${this._who}: ${JSON.stringify(msg.toString("latin1"))}` : `Send to ${this._who}: ${msg.length} bytes`);
    const nonce = nonceFor(this._send_nonce);
    this._send_nonce += 2;
    const data = Buffer.from(this._box.encrypt(msg, nonce));
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(data.length));
    await this._send(Buffer.concat([len, data]));
  }

  send_json(msg) { return this.send(Buffer.from(pyJsonDumps(msg), "utf8")); }

  async receive() {
    let length_data = await this._receive(8);
    if (length_data[0]) {
      length_data = Buffer.concat([length_data, await this._receive_max(1024)]);
      throw new Error(`Got unexpected data from ${this._who}: ${JSON.stringify(length_data.toString("latin1"))}`);
    }
    const length = Number(length_data.readBigUInt64BE());
    const data = await this._receive(length);
    const nonce = nonceFor(this._receive_nonce);
    this._receive_nonce += 2;
    let msg;
    try { msg = Buffer.from(this._box.decrypt(data, nonce)); } catch { throw new Error("Decryption failed. Ciphertext failed verification"); }
    if (DEBUG_MODE) debug_print(msg.length <= 300 ? `Receive from ${this._who}: ${JSON.stringify(msg.toString("latin1"))}` : `Receive from ${this._who}: ${msg.length} bytes`);
    return msg;
  }

  async receive_json() {
    const ret = pyJsonLoads((await this.receive()).toString("utf8"));
    if (typeof ret === "string") throw new ServerError(ret);
    if (ret == null || typeof ret !== "object" || Array.isArray(ret)) throw new Error("Top-level JSON value must be a dictionary");
    return ret;
  }
}

export class SocketPort extends Port {
  constructor(sock, reader, box, who, { is_client }) {
    super(box, who, { is_client });
    this._sock = sock;
    this._reader = reader;
  }

  _send(data) {
    return new Promise((resolve, reject) => {
      if (this._sock.destroyed || this._sock.writableEnded) { reject(new EOFError("broken pipe")); return; }
      this._sock.write(data, (e) => (e ? reject(new EOFError(e.message)) : resolve()));
    });
  }

  _receive(n) { return this._reader.readExact(n); }

  _receive_max(n) { return this._reader.readMax(n); }

  shutdown() { try { this._sock.end(); } catch { /* closed */ } }

  close() { try { this._sock.destroy(); } catch { /* closed */ } }
}

/** A Port over a pair of byte streams (the evaluator's stdin/stdout). */
export class FilePort extends Port {
  constructor(input, output, box, who, { is_client }) {
    super(box, who, { is_client });
    this._reader = new StreamReader(input);
    this._out = output;
  }

  _send(data) {
    return new Promise((resolve, reject) => {
      this._out.write(data, (e) => (e ? reject(new EOFError(e.message)) : resolve()));
    });
  }

  _receive(n) { return this._reader.readExact(n); }

  _receive_max(n) { return this._reader.readMax(n); }
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    sock.once("connect", () => { sock.removeAllListeners("error"); resolve(sock); });
    sock.once("error", (e) => {
      if (e.code === "ECONNREFUSED") reject(new EOFError("connection refused"));
      else if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") reject(new EOFError(`DNS lookup failed: ${e.message}`));
      else reject(new EOFError("unable to connect: " + (e.message || e.code)));
    });
  });
}

/** The client side of the controller handshake (core._do_connect). */
async function _do_connect(config) {
  await nacl();
  if (!config.server_verify_key || !config.signing_key || !config.server_address) {
    throw new EOFError("Using permuter@home requires someone to give you access to a central -J server.\nRun `romdev-permuter-remote setup` to set this up.");
  }
  const [host, port_str] = config.server_address.split(":");
  const sock = await connectTcp(host, Number(port_str));
  sock.setNoDelay(true);
  const reader = new StreamReader(sock);
  const eph = sodium.crypto_box_keypair();
  sock.write(concat(enc("p@h0"), eph.publicKey));
  const msg = await reader.readExact(32 + 64);
  const server_enc_key_data = msg.subarray(0, 32);
  config.server_verify_key.verify(concat(enc("HELLO:"), eph.publicKey, server_enc_key_data), msg.subarray(32));
  const box = new Box(eph.privateKey, server_enc_key_data);
  const port = new SocketPort(sock, reader, box, "controller", { is_client: true });
  const signature = config.signing_key.sign(concat(enc("WORLD:"), server_enc_key_data));
  const ver = Buffer.alloc(4);
  ver.writeUInt32BE(PERMUTER_VERSION);
  await port.send(concat(config.signing_key.verify_key.encode(), signature, ver));
  const obj = await port.receive_json();
  if ("message" in obj) process.stdout.write(`${obj.message}\n`);
  return port;
}

/** Authenticate and connect to the permuter@home controller server. */
export async function connect(config = null) {
  if (!config) config = await read_config();
  return _do_connect(config);
}
