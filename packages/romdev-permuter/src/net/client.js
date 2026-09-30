// client.js - the -J side of permuter@home, a port of decomp-permuter's
// src/net/client.py: hand one permuter to the controller, then relay seeds
// out and results back into the local search loop.
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { json_prop, permuter_data_to_json, EOFError } from "./core.js";

function _result_from_json(obj, source) {
  if ("error" in obj) return { isEvalError: true, exc_str: json_prop(obj, "error", "string"), seed: null };
  let profiler = null;
  if ("profiler" in obj) {
    profiler = {};
    for (const [k, v] of Object.entries(json_prop(obj, "profiler", "dict"))) {
      if (!["perm", "stringify", "compile", "score"].includes(k)) throw new Error(`KeyError: '${k}'`);
      if (typeof v !== "number") throw new Error(`Member ${k} must have type float`);
      profiler[k] = v;
    }
  }
  return { score: json_prop(obj, "score", "int"), hash: "hash" in obj ? json_prop(obj, "hash", "string") : null, source, profiler };
}

/**
 * Strip the machine-specific parts import.py puts in compile.sh: absolute
 * `cd`s, and absolute program paths become `$(which <name>)`.
 */
export function _make_script_portable(source) {
  const lines = [];
  for (let line of source.split("\n")) {
    if (/^cd '?\//.test(line)) continue;
    if (/^'?\//.test(line)) {
      const quote = line[0] === "'" ? "'" : "";
      let ind = line.indexOf(quote + " ");
      if (ind === -1) ind = line.length;
      else ind += quote.length;
      const lastind = line.lastIndexOf("/", ind - 1);
      if (lastind === -1) throw new Error("AssertionError");
      line = "$(which " + quote + line.slice(lastind + 1, ind) + ")" + line.slice(ind);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function make_portable_permuter(permuter) {
  return {
    base_score: permuter.base_score,
    base_hash: permuter.base_hash,
    fn_name: permuter.fn_name,
    filename: permuter.source_file,
    keep_prob: permuter.keep_prob,
    need_profiler: permuter.need_profiler,
    stack_differences: permuter.scorer.stack_differences,
    algorithm: permuter.scorer.algorithm,
    randomization_weights: permuter.randomization_weights,
    compile_script: _make_script_portable(readFileSync(permuter.compiler.compile_cmd, "utf8")),
    source: permuter.source,
    target_o_bin: readFileSync(permuter.scorer.target_o),
    ign_branch_targets: permuter.scorer.ign_branch_targets,
    objdump_command: permuter.scorer.objdump_command,
  };
}

/**
 * One permuter's connection. Feedback goes to `feedback(item, permIndex, serverNick)`
 * with items {type:"need_work"} | {type:"message", text} | {type:"done", result} |
 * {type:"finished", reason}; tasks are pulled with `nextTask()` (null = no more).
 */
export class Connection {
  constructor(port, permuter_data, perm_index, nextTask, feedback) {
    this._port = port;
    this._permuter_data = permuter_data;
    this._perm_index = perm_index;
    this._nextTask = nextTask;
    this._feedbackFn = feedback;
  }

  async _send_permuter() {
    const data = this._permuter_data;
    await this._port.send_json(permuter_data_to_json(data));
    await this._port.send(deflateSync(Buffer.from(data.source, "utf8")));
    await this._port.send(deflateSync(data.target_o_bin));
  }

  _feedback(item, server_nick) { this._feedbackFn(item, this._perm_index, server_nick); }

  async _receive_one() {
    const msg = await this._port.receive_json();
    const msg_type = json_prop(msg, "type", "string");
    if (msg_type === "need_work") return true;
    const server_nick = json_prop(msg, "server", "string");
    if (msg_type === "init_done") {
      const base_hash = json_prop(msg, "hash", "string");
      let text = "connected";
      if (base_hash !== this._permuter_data.base_hash) text += " (note: mismatching hash)";
      this._feedback({ type: "message", text }, server_nick);
      return true;
    }
    if (msg_type === "init_failed") {
      this._feedback({ type: "message", text: "failed to initialize: " + json_prop(msg, "reason", "string") }, server_nick);
      return false;
    }
    if (msg_type === "disconnect") {
      this._feedback({ type: "message", text: "disconnected" }, server_nick);
      return false;
    }
    if (msg_type === "result") {
      let source = null;
      if (msg.has_source === true) {
        const compressed = await this._port.receive();
        try {
          source = inflateSync(compressed).toString("utf8");
        } catch (e) {
          this._feedback({ type: "message", text: "failed to decompress: " + (e.message || e.name) }, server_nick);
          return true;
        }
      }
      try {
        this._feedback({ type: "done", result: _result_from_json(msg, source) }, server_nick);
      } catch (e) {
        this._feedback({ type: "message", text: "failed to parse result message: " + (e.message || e.name) }, server_nick);
      }
      return true;
    }
    throw new Error(`Invalid message type ${msg_type}`);
  }

  async run() {
    let finish_reason = null;
    try {
      await this._send_permuter();
      await this._port.receive_json();
      let finished = false;
      for (;;) {
        if (!await this._receive_one()) continue;
        this._feedback({ type: "need_work" }, null);
        if (!finished) {
          const task = await this._nextTask();
          if (task == null) finished = true;
          else await this._port.send_json({ type: "work", work: { seed: task } });
        }
      }
    } catch (e) {
      if (e instanceof EOFError) finish_reason = "disconnected from permuter@home";
      else finish_reason = `permuter@home error: ${e.message || e.name}`;
    } finally {
      this._feedback({ type: "finished", reason: finish_reason }, null);
      this._port.shutdown();
      this._port.close();
    }
  }
}

/** start_client: announce ourselves and start the relay. Returns {done, stats}. */
export async function start_client(port, permuter, perm_index, nextTask, feedback, priority) {
  await port.send_json({ method: "connect_client", priority });
  const obj = await port.receive_json();
  if ("error" in obj) throw new Error(`Failed to connect: ${json_prop(obj, "error", "string")}`);
  const stats = [json_prop(obj, "clients", "int"), json_prop(obj, "servers", "int"), json_prop(obj, "cores", "float")];
  const conn = new Connection(port, make_portable_permuter(permuter), perm_index, nextTask, feedback);
  const done = conn.run();
  return { done, stats };
}
