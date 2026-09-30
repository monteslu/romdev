#!/usr/bin/env node
// evaluator.js - permuter@home's sandboxed evaluator, a port of
// decomp-permuter's src/net/evaluator.py. It runs as its own process, talks
// to the worker server over stdin/stdout (SecretBox, key in $SECRET), and
// evaluates candidates in worker threads.
//
// Upstream runs this inside a Docker container that provides the compiler.
// Here the compiler is romdev's WASM toolchain: a job's (portable) compile.sh
// is run through the toolchain adapter, never through bash, with its program
// names resolved by the server's toolchain profile, and it is refused if it
// names any path outside the job's own working directory.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { FilePort, SecretBox, nacl, json_prop, permuter_data_from_json } from "./core.js";
import { Permuter } from "../permuter.js";
import { Scorer } from "../scorer.js";
import { Compiler } from "../compiler.js";
import { CandidateConstructionFailure } from "../error.js";
import { resolveToolchainUrl } from "../import.js";
import { shlexSplit } from "../scorer.js";

const EVAL_WORKER = new URL("./evaluator-worker.js", import.meta.url);

/**
 * Bind a portable compile script to this machine: `$(which NAME)` becomes the
 * profile's program path for NAME, and any other absolute path or `..`
 * component is refused (the script comes from someone else's machine).
 */
export function bindScript(script, programs) {
  const out = [];
  for (let line of script.split("\n")) {
    line = line.replace(/\$\(which '?([^')]+)'?\)/g, (_m, name) => {
      if (!(name in programs)) throw new CandidateConstructionFailure(`compile script needs program '${name}', which this server's toolchain profile does not provide`);
      return programs[name];
    });
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || /^(set|export)\s/.test(trimmed) || /^[A-Za-z_][A-Za-z0-9_]*="\$\(realpath "\$[13]"\)"$/.test(trimmed)) {
      out.push(line);
      continue;
    }
    if (/^cd\s/.test(trimmed)) throw new CandidateConstructionFailure("compile script may not change directory");
    const words = shlexSplit(trimmed.replaceAll('"$INPUT"', "@IN@").replaceAll('"$OUTPUT"', "@OUT@"));
    for (const w of words) {
      if (w === "@IN@" || w === "@OUT@") continue;
      const bare = w.replace(/^-[A-Za-z]+=?/, "");
      if (path.isAbsolute(bare) || bare.split("/").includes("..")) {
        throw new CandidateConstructionFailure(`compile script names a path outside its job directory: ${w}`);
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Toolchain profiles a server offers (the controller's "docker_image"). */
export function profilePrograms(image) {
  const presets = {
    "romdev:ido5.3": { cc: "ido/5.3/cc" },
    "romdev:ido7.1": { cc: "ido/7.1/cc" },
  };
  if (presets[image]) return presets[image];
  const m = /^romdev:(.+)$/.exec(image);
  if (m && m[1].includes("=")) {
    return Object.fromEntries(m[1].split(",").map((kv) => kv.split("=")).map(([k, v]) => [k.trim(), v.trim()]));
  }
  throw new Error(`unsupported toolchain image '${image}': romdev servers run 'romdev:ido5.3', 'romdev:ido7.1' or 'romdev:<name>=<program>,...'`);
}

async function main() {
  await nacl();
  const secret = Buffer.from(process.env.SECRET, "base64");
  delete process.env.SECRET;
  process.env.PERMUTER_IS_REMOTE = "1";
  const programs = profilePrograms(process.env.PAH_IMAGE ?? "");
  const out = process.stdout;
  // print() debugging goes to stderr; stdout is the protocol.
  console.log = (...a) => process.stderr.write(a.join(" ") + "\n");
  const port = new FilePort(process.stdin, out, new SecretBox(secret), "server", { is_client: false });
  const magic = await port.receive();
  await port.send(magic);
  const obj = await port.receive_json();
  const num_threads = Math.ceil(json_prop(obj, "num_cores", "float"));
  const workRoot = process.env.PAH_WORKDIR ?? path.join(process.cwd(), ".pah-work");
  mkdirSync(workRoot, { recursive: true });
  const jail = mkdtempSync(path.join(workRoot, "pah-eval-"));
  const toolchainUrl = resolveToolchainUrl();
  if (!toolchainUrl) throw new Error("the evaluator needs romdev's toolchain adapter (romdevtools)");

  const permuters = new Map(); // perm_id -> {dir, config}
  const remaining = new Map();
  const shouldRemove = new Set();
  const workers = [];
  const idle = [];
  const queue = [];
  const dispatch = () => {
    while (idle.length && queue.length) {
      const w = idle.pop();
      w.postMessage({ type: "work", ...queue.shift() });
    }
  };
  const removeNow = (perm_id) => {
    if (!shouldRemove.has(perm_id) || (remaining.get(perm_id) ?? 0) !== 0) return;
    shouldRemove.delete(perm_id);
    remaining.delete(perm_id);
    for (const w of workers) w.postMessage({ type: "remove", perm_id });
    rmSync(permuters.get(perm_id).dir, { recursive: true, force: true });
    permuters.delete(perm_id);
  };
  let sendChain = Promise.resolve();
  const send = (fn) => { sendChain = sendChain.then(fn).catch(() => process.exit(1)); return sendChain; };
  for (let k = 0; k < num_threads; k++) {
    const w = new Worker(EVAL_WORKER, { workerData: { toolchainUrl } });
    w.on("message", (msg) => {
      if (msg.type === "result") {
        remaining.set(msg.perm_id, (remaining.get(msg.perm_id) ?? 0) - 1);
        send(async () => {
          const o = { type: "result", permuter: msg.perm_id, id: msg.id, time_us: msg.time_us };
          const res = msg.result;
          if (res.isEvalError) {
            o.error = res.exc_str ?? "";
            await port.send_json(o);
          } else {
            o.score = res.score;
            o.has_source = res.source != null;
            if (res.hash != null) o.hash = res.hash;
            if (res.profiler) o.profiler = res.profiler;
            await port.send_json(o);
            if (res.source != null) await port.send(deflateSync(Buffer.from(res.source, "utf8")));
          }
        });
        if (permuters.has(msg.perm_id)) removeNow(msg.perm_id);
        idle.push(w);
        dispatch();
      }
    });
    w.on("error", (e) => { process.stderr.write(`evaluator worker: ${e.stack ?? e}\n`); process.exit(1); });
    workers.push(w);
    idle.push(w);
  }

  const cleanup = () => { try { rmSync(jail, { recursive: true, force: true }); } catch { /* ignore */ } };
  process.on("exit", cleanup);
  try {
    for (;;) {
      const item = await port.receive_json();
      const msg_type = json_prop(item, "type", "string");
      if (msg_type === "add") {
        const perm_id = json_prop(item, "permuter", "string");
        const source = (await port.receive()).toString("utf8");
        const target_o_bin = await port.receive();
        const data = permuter_data_from_json(item, source, target_o_bin);
        const msg = { type: "init", permuter: perm_id };
        const t0 = performance.now();
        const dir = path.join(jail, `p${perm_id.replace(/[^0-9A-Za-z_-]/g, "_")}`);
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, "target.o"), target_o_bin);
          writeFileSync(path.join(dir, "compile.sh"), bindScript(data.compile_script, programs), { mode: 0o755 });
          const config = {
            permOpts: { dir: "unused", fn_name: data.fn_name, source_file: data.filename, source: data.source,
              randomization_weights: data.randomization_weights, force_seed: null, force_rng_seed: null,
              keep_prob: data.keep_prob, need_profiler: data.need_profiler, need_all_sources: false, show_errors: false,
              best_only: false, better_only: false, score_threshold: null, debug_mode: false, speed: 100 },
            scorerOpts: { target_o: path.join(dir, "target.o"), stack_differences: data.stack_differences, algorithm: data.algorithm,
              debug_mode: false, ign_branch_targets: data.ign_branch_targets, objdump_command: data.objdump_command },
            compile_cmd: path.join(dir, "compile.sh"),
            tmpDir: path.join(dir, "tmp"),
          };
          // Construct once here (compiles the base) to check the base score.
          const { compileWithScript } = await import(toolchainUrl);
          const compiler = new Compiler(config.compile_cmd, { tmpDir: config.tmpDir, compileFn: (c, o, script) => compileWithScript(c, o, null, script), log: () => {} });
          const scorer = await Scorer.create(config.scorerOpts);
          const permuter = await Permuter.create({ ...config.permOpts, compiler, scorer, log: () => {} });
          if (permuter.base_score !== data.base_score) {
            rmSync(dir, { recursive: true, force: true });
            const hash_str = permuter.base_hash === data.base_hash ? "same hash; different Python or permuter versions?" : "different hash; different objdump versions?";
            throw new CandidateConstructionFailure(`mismatching score: ${permuter.base_score} vs ${data.base_score} (${hash_str})`);
          }
          config.base = { score: permuter.base_score, hash: permuter.base_hash, source: permuter.base_source };
          permuters.set(perm_id, { dir, config });
          for (const w of workers) w.postMessage({ type: "add", perm_id, config });
          Object.assign(msg, { success: true, base_score: permuter.base_score, base_hash: permuter.base_hash });
        } catch (e) {
          msg.success = false;
          msg.error = e.message || e.name;
          if (e instanceof CandidateConstructionFailure) process.stderr.write(e.message + "\n");
          else process.stderr.write(String(e.stack ?? e) + "\n");
        }
        msg.time_us = Math.trunc((performance.now() - t0) * 1000);
        await send(() => port.send_json(msg));
      } else if (msg_type === "remove") {
        const perm_id = json_prop(item, "permuter", "string");
        if (permuters.has(perm_id)) {
          shouldRemove.add(perm_id);
          removeNow(perm_id);
        }
      } else if (msg_type === "work") {
        const perm_id = json_prop(item, "permuter", "string");
        const id = json_prop(item, "id", "int");
        const seed = json_prop(item, "seed", "int");
        remaining.set(perm_id, (remaining.get(perm_id) ?? 0) + 1);
        queue.push({ perm_id, id, seed });
        dispatch();
      } else {
        throw new Error(`Invalid message type ${msg_type}`);
      }
    }
  } catch (e) {
    if (e?.name !== "EOFError") process.stderr.write(String(e.stack ?? e) + "\n");
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
