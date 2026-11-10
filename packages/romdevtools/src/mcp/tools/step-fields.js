// Debug fields read at the end of a ranged step, and a stop condition on one
// of them: what lets a bot look at a cart ONCE per decision. `fields` names
// wasm({op:'debugState'}) fields; they are read through the host's
// readDebugValue (the cart's own typed value, as frame({op:'timing'}) reads
// its debugFields), never from the listing (which caps arrays and byte
// fields). `stopWhen` ends the range as soon as a field has a value, checked
// every `every` frames (default 1), so a bot that holds a direction for 12
// frames stops the moment the goal field flips instead of overrunning it.

/** The value of a debug field as a bot wants it: a number, an array of numbers, or the text of a bytes field. */
export function fieldValue(host, name) {
  if (typeof host?.readDebugValue !== "function") {
    throw new Error(`fields: this host has no debug fields (a wasmcart cart with WC_FLAG_DEBUG and wc_debug_state(), or a host that exposes readDebugValue); '${name}' cannot be read`);
  }
  const v = host.readDebugValue(name);
  if (v == null) throw new Error(`fields: no debug field '${name}' (wasm({op:'debugState'}) lists the cart's fields)`);
  if (v.bytes) {
    const b = v.bytes;
    let end = b.length;
    while (end > 0 && b[end - 1] === 0) end--;
    return Buffer.from(b.subarray ? b.subarray(0, end) : b.slice(0, end)).toString("utf8");
  }
  if (Array.isArray(v.values)) return v.values.map(num);
  if ("value" in v) return num(v.value);
  if (typeof v.text === "string") return v.text;
  return v;
}

function num(x) { return typeof x === "bigint" ? Number(x) : x; }

/** Every named field's value, as {name: value}. Unknown names throw (fail fast: a typo must not read as "not yet"). */
export function readFields(host, names) {
  const out = {};
  for (const n of names) out[n] = fieldValue(host, n);
  return out;
}

/**
 * Validate a stopWhen clause: {field, equals|atLeast|atMost, index?, every?}.
 * Returns the normalised clause or throws with the shape.
 */
export function parseStopWhen(stopWhen, tool) {
  if (stopWhen == null) return null;
  const bad = (why) => new Error(`${tool}: stopWhen ${why}: pass {field:'game.done', equals:1} (or atLeast / atMost; index picks an element of an array field; every = frames between checks, default 1)`);
  if (typeof stopWhen !== "object" || Array.isArray(stopWhen)) throw bad("must be an object");
  if (typeof stopWhen.field !== "string" || !stopWhen.field) throw bad("needs a field name");
  const tests = ["equals", "atLeast", "atMost"].filter((k) => stopWhen[k] !== undefined);
  if (tests.length !== 1) throw bad(tests.length ? "takes one of equals, atLeast, atMost" : "needs equals, atLeast or atMost");
  const every = stopWhen.every === undefined ? 1 : stopWhen.every;
  if (!Number.isInteger(every) || every < 1) throw bad("`every` must be a whole number of frames, 1 or more");
  const index = stopWhen.index === undefined ? 0 : stopWhen.index;
  if (!Number.isInteger(index) || index < 0) throw bad("`index` must be 0 or more");
  return { field: stopWhen.field, test: tests[0], target: stopWhen[tests[0]], index, every };
}

/** Does the field's current value satisfy the clause? Returns {hit, value}. */
export function stopWhenHit(host, sw) {
  const raw = fieldValue(host, sw.field);
  const value = Array.isArray(raw) ? raw[sw.index] : raw;
  const t = sw.target;
  const hit = sw.test === "equals" ? value === t || (typeof value === "number" && typeof t === "number" && Math.abs(value - t) < 1e-9)
    : sw.test === "atLeast" ? Number(value) >= Number(t)
    : Number(value) <= Number(t);
  return { hit, value };
}

/**
 * Step `frames` frames on `host`, stopping early when `sw` (a parsed stopWhen)
 * is met. Returns {framesRun, stopped: null | {field, value}}. Without a clause
 * the whole range is one stepFrames call, as before.
 */
export async function stepUntil(host, frames, sw) {
  if (!sw) return { framesRun: await host.stepFrames(frames), stopped: null };
  let run = 0;
  while (run < frames) {
    const n = Math.min(sw.every, frames - run);
    const got = await host.stepFrames(n);
    run += got;
    const { hit, value } = stopWhenHit(host, sw);
    if (hit) return { framesRun: run, stopped: { field: sw.field, value } };
    if (got < n) break; // a paused host runs nothing: do not spin
  }
  return { framesRun: run, stopped: null };
}
