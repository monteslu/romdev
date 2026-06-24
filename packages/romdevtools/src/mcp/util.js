// Small helpers for MCP tool responses.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ── Large-output discipline: path-required-unless-inline ──────────
// Every tool that can produce a large payload (ROM bytes, dumps, asm,
// tile blobs, PNGs, big logs) follows ONE rule:
//   • `inline` defaults to FALSE.
//   • inline:false  → the caller MUST supply an output path. We write the
//     payload there and return just { path, bytes }. No silent default
//     location → nothing ever lands somewhere the user can't find / loses.
//   • inline:true   → the payload comes back in the response, no path.
// This keeps the common call cheap on context AND prevents the "my ROM
// went to /tmp and got wiped" footgun — the agent must say where it goes.

/**
 * Enforce the path-or-inline contract and (when not inline) write to disk.
 * Throws a clear error if neither `outputPath` nor `inline` was given.
 * @param {Uint8Array|Buffer|string} data  the payload to persist when not inline
 * @param {{ outputPath?: string, inline?: boolean, what?: string, encoding?: BufferEncoding }} opts
 * @returns {{ path: string, bytes: number }} when written to disk
 */
export function writeOutput(data, { outputPath, inline = false, what = "output", encoding } = {}) {
  if (inline) {
    throw new Error("writeOutput called with inline:true — caller should return the payload inline instead of writing.");
  }
  if (!outputPath) {
    throw new Error(
      `No output path given for ${what}. Pass outputPath (absolute path / dir where it should be saved — ` +
      `e.g. your project dir) or inline:true to get it back in the response.`,
    );
  }
  const buf = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : Buffer.from(data);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buf);
  return { path: outputPath, bytes: buf.length };
}

/** Wrap a JSON object as an MCP tool text-content result. */
export function jsonContent(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

/** Wrap a plain string as an MCP tool text-content result. */
export function textContent(text) {
  return {
    content: [{ type: "text", text }],
  };
}

/** Build an image content block from a base64-encoded PNG. */
export function imageContent(pngBase64) {
  return {
    type: "image",
    data: pngBase64,
    mimeType: "image/png",
  };
}

/** Wrap an Error as a tool error result. */
export function errorContent(err) {
  // UnsupportedError carries the structured capability-contract fields so an
  // agent can branch on `unsupported: true` instead of string-matching the
  // message. We surface BOTH a clean sentence and the structured fields.
  if (err && err.name === "UnsupportedError") {
    const text = err.message + (err.alternative ? ` (try: ${err.alternative})` : "");
    return {
      isError: true,
      unsupported: true,
      platform: err.platform,
      op: err.op,
      reason: err.reason ?? null,
      alternative: err.alternative ?? null,
      content: [{ type: "text", text }],
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: String(err?.message ?? err) }],
  };
}

/**
 * The single, uniform "this platform doesn't support this op" signal. Throws a
 * typed UnsupportedError that safeTool → errorContent formats consistently
 * (and that programmatic callers / the conformance test can catch + inspect).
 * Replaces the ad-hoc "not supported"/"not yet wired" throws.
 *
 * @param {string} platform
 * @param {string} op        a capability op key (see cores/capabilities.js OP_KEYS)
 * @param {{reason?:string, alternative?:string}} [opts]
 * @returns {never}
 */
export function unsupported(platform, op, { reason, alternative } = {}) {
  const base = `'${op}' is not supported on platform '${platform}'`;
  const err = new Error(reason ? `${base}: ${reason}` : base + ".");
  err.name = "UnsupportedError";
  err.platform = platform;
  err.op = op;
  err.reason = reason ?? null;
  err.alternative = alternative ?? null;
  throw err;
}

/**
 * Wrap a tool implementation so any thrown error becomes a structured tool
 * error rather than a transport-layer exception.
 * @template T
 * @param {(args: T) => Promise<any> | any} fn
 */
export function safeTool(fn) {
  return async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return errorContent(err);
    }
  };
}

// ── Clear tool-call validation errors ───────────────────────────────────────
// The MCP SDK validates args against the registered zod schema BEFORE our
// handler runs, and on failure throws a raw JSON dump ("Input validation error:
// [{...}]"). It also silently DROPS unknown keys (so `addr` instead of `offset`
// fails silently). Param descriptions can't fix either — and they cost every
// agent context on every connect. So instead we keep param docs terse and put
// the guidance in the ERROR (paid only by the agent who errs, only when it errs).
//
// `validateArgs(shape, args, toolName)` runs OUR own check first and throws a
// plain-sentence Error (caught by safeTool → errorContent) for: bad enum value,
// wrong type, missing required field, and unknown/misspelled param (with a
// "did you mean" nearest-match). Tool handlers call it at the top; the registered
// SDK schema is kept permissive so this layer is the one that speaks.

/**
 * Wrap an McpServer's `tool()` so every registered tool gets clear validation
 * errors instead of the SDK's raw JSON dump — and unknown/misspelled params are
 * caught (the SDK strips them silently by default). Call ONCE at the top of
 * registerTools(): `server = withClearToolErrors(server, z)`.
 *
 * Mechanism (zod v4 + MCP SDK): the SDK builds `z.object(shape)` from the shape
 * we pass, safeParses the args, and surfaces `issues[0].message`. We instead
 * register a `.strict()` object carrying a custom `error` map that returns a
 * plain sentence per issue (enum/type/missing/unknown-key with "did you mean").
 * So the SDK's own validator emits good text — no ordering fight, no per-tool code.
 *
 * @param {any} server  the McpServer
 * @param {any} z       the zod module
 * @returns {any} the same server (tool() now wrapped)
 */
/** Install the global zod error map once (idempotent). Field-level issues
 *  (bad enum, wrong type, missing required) go through this on the SDK's parse
 *  path, which doesn't pass a per-call error option. Object-level issues
 *  (unrecognized_keys) are handled per-schema in strictFriendlyObject (it has
 *  the valid-key list for "did you mean"). */
let _zodErrorConfigured = false;
function installGlobalZodErrors(z) {
  if (_zodErrorConfigured || typeof z.config !== "function") return;
  _zodErrorConfigured = true;
  z.config({
    customError: (issue) => {
      const path = (issue.path && issue.path.length ? issue.path.join(".") : null);
      switch (issue.code) {
        case "invalid_value":
        case "invalid_enum_value": {
          const opts = issue.values || issue.options || [];
          if (!opts.length || !path) return undefined;
          return `'${path}' must be one of: ${opts.join(" | ")}.`;
        }
        case "invalid_type": {
          if (!path) return undefined;
          if (issue.input === undefined) return `missing required parameter '${path}'.`;
          return `'${path}' must be a ${issue.expected}.`;
        }
        default:
          return undefined; // zod default (incl. unrecognized_keys, handled per-schema)
      }
    },
  });
}

export function withClearToolErrors(server, z) {
  installGlobalZodErrors(z);
  const origTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    // Register normally (the SDK requires a RAW shape as inputSchema and builds
    // z.object(shape) itself — passing a built object is rejected). THEN patch
    // the stored tool's inputSchema to a `.strict()` object carrying a custom
    // error map. Both validation AND tools/list go through the stored schema
    // (the SDK calls normalizeObjectSchema(tool.inputSchema) for each), so this
    // makes the SDK itself: (a) reject unknown/misspelled params (.strict) with
    // a "did you mean", and (b) emit a clean sentence for bad enum / wrong type
    // / missing — instead of its raw JSON dump. No ordering fight; the param
    // descriptions can stay terse because the guidance lives in the error.
    const shapeIdx = rest.findIndex(
      (x) => x && typeof x === "object" && !Array.isArray(x) && !("_def" in x) &&
        Object.values(x).some((v) => v && typeof v === "object" && "_def" in v),
    );
    const shape = shapeIdx >= 0 ? rest[shapeIdx] : null;
    const result = origTool(name, ...rest);
    if (shape) {
      try {
        const reg = server._registeredTools && server._registeredTools[name];
        if (reg) reg.inputSchema = strictFriendlyObject(z, shape, name);
      } catch { /* if the SDK internals shift, fall back to the SDK's own errors */ }
    }
    return result;
  };
  return server;
}

// ── Hex-string coercion on address-like params ─────────────────────
// JSON forbids `0x…` number literals, so an agent that pastes an address as hex
// (`{address: 0xC06C}`) gets a HARD parse error, and even valid JSON can't carry
// hex. We accept the STRING forms `"0x…"`, `"$…"`, and decimal strings on
// address-like params and coerce them to a number BEFORE validation, so the
// natural thing an agent reaches for just works. (Reported repeatedly in v0.41.0
// feedback as the #1 first-try-fail.)
//
// Matched by KEY NAME (not schema introspection — robust across zod versions).
// DELIBERATELY NARROW: only names that are unambiguously a numeric address/offset
// across the toolset. Names like `start`/`end`/`from`/`to`/`target`/`compare` are
// EXCLUDED because they're also booleans (the START button) or enums (`compare:'eq'`,
// `from:'aseprite'`); the coercer passes non-hex strings through, but not wrapping
// them at all keeps those schemas pristine. Address-suffixed forms (`startAddress`,
// `endAddress`) DO match and cover the range-bound case.
const ADDR_KEY_RE = /^(address|cpuAddress|addr|offset|pc|compare|startAddress|endAddress|baseAddress|targetAddress|fromAddress|toAddress|romOffset|prgOffset|vramAddr)$/i;

/** Coerce `"0x1A"` / `"$1A"` / `"26"` → number; pass through numbers/undefined/
 *  non-hex strings unchanged (so a non-numeric value still hits the real schema
 *  error). Exported for unit tests. */
export function coerceHexNumber(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (/^[$]([0-9a-fA-F]+)$/.test(s)) return parseInt(s.slice(1), 16);
  if (/^0x[0-9a-fA-F]+$/i.test(s)) return parseInt(s, 16);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return v; // leave anything else for the inner schema to reject
}

/**
 * Build a `.strict()` z.object from a tool's shape whose validation issues each
 * render as a clear sentence (unknown-key "did you mean", enum options, missing
 * required, wrong type). Used by withClearToolErrors to replace the stored schema.
 * Also wraps address-like params with hex-string coercion (see coerceHexNumber).
 * @param {any} z
 * @param {Record<string, any>} shape
 * @param {string} toolName
 */
function strictFriendlyObject(z, shape, toolName) {
  // Wrap address-like fields with a hex-string→number preprocessor. z.preprocess
  // runs the coercion first, then the field's own schema (number().int()…)
  // validates the result — so descriptions, optionality, and ranges are preserved.
  const coercedShape = {};
  for (const [key, schema] of Object.entries(shape)) {
    if (ADDR_KEY_RE.test(key)) {
      // z.preprocess drops the wrapper's .description (which tools/list needs),
      // so re-attach the field's own description to the wrapped schema.
      const wrapped = z.preprocess(coerceHexNumber, schema);
      coercedShape[key] = schema.description ? wrapped.describe(schema.description) : wrapped;
    } else {
      coercedShape[key] = schema;
    }
  }
  shape = coercedShape;
  const validKeys = Object.keys(shape);
  const errorMap = (issue) => {
    switch (issue.code) {
      case "unrecognized_keys": {
        const bad = (issue.keys && issue.keys[0]) || "?";
        const hint = suggestKey(bad, validKeys);
        return `${toolName}: unknown parameter '${bad}'.` +
          (hint ? ` Did you mean '${hint}'?` : "") +
          ` Valid: ${validKeys.join(", ")}.`;
      }
      case "invalid_value":
      case "invalid_enum_value": {
        const opts = issue.values || issue.options || [];
        const path = (issue.path && issue.path.length ? issue.path.join(".") : "value");
        return `${toolName}: '${path}' must be one of: ${opts.join(" | ")}.`;
      }
      case "invalid_type": {
        const path = (issue.path && issue.path.length ? issue.path.join(".") : "value");
        if (issue.input === undefined || issue.received === "undefined") {
          return `${toolName}: missing required parameter '${path}'. Valid params: ${validKeys.join(", ")}.`;
        }
        return `${toolName}: '${path}' must be a ${issue.expected}.`;
      }
      default:
        return undefined; // zod's default message for anything else
    }
  };
  return z.object(shape, { error: errorMap }).strict();
}

/** Levenshtein distance (small, for "did you mean" suggestions). */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Conceptual aliases agents reach for reflexively that are NOT close typos of
// the real param name (edit-distance won't catch addr→offset). Suggested only
// when the real key is actually valid for the tool.
const PARAM_ALIASES = {
  addr: ["offset", "address"], address: ["offset"], pos: ["offset"], position: ["offset"],
  len: ["length"], size: ["length"], count: ["length", "count"], num: ["count"],
  data: ["hex", "base64", "bytes"], bytes: ["hex", "base64"], buf: ["base64"], buffer: ["base64"],
  file: ["path"], filepath: ["path"], filename: ["path"], src: ["path", "source"], dest: ["path", "outputPath"],
  out: ["outputPath"], output: ["outputPath"], rom: ["path"],
  reg: ["regId"], register: ["regId"], val: ["value"], pc: ["pc", "address"],
  freq: ["frequency"], chan: ["channel"], plat: ["platform"], sys: ["system"], op: ["op"],
};

/** Nearest valid key to `bad`: a known conceptual alias first, else a close typo. */
function suggestKey(bad, valid) {
  const lb = bad.toLowerCase();
  const validLower = new Set(valid.map((v) => v.toLowerCase()));
  // 1) conceptual alias → the first candidate that's actually a valid key here.
  for (const cand of (PARAM_ALIASES[lb] || [])) {
    if (validLower.has(cand.toLowerCase())) {
      return valid.find((v) => v.toLowerCase() === cand.toLowerCase());
    }
  }
  // 2) closest typo within a tight threshold.
  let best = null, bestD = Infinity;
  for (const k of valid) {
    const d = editDistance(lb, k.toLowerCase());
    if (d < bestD) { bestD = d; best = k; }
  }
  return best != null && bestD <= Math.max(2, Math.ceil(best.length * 0.4)) ? best : null;
}

/** Pull the enum option list out of a zod schema (v3/v4), or null. */
function enumValues(zodType) {
  const d = zodType?._def;
  if (!d) return null;
  // zod v3: ZodEnum has .values / _def.values; v4 similar
  if (Array.isArray(zodType.options)) return zodType.options;
  if (Array.isArray(d.values)) return d.values;
  if (d.entries && typeof d.entries === "object") return Object.values(d.entries);
  return null;
}

/**
 * Validate a tool call's args against the tool's zod SHAPE (the plain object of
 * field→zodType passed to server.tool) and throw clear, actionable errors.
 * Returns the args unchanged on success (the handler keeps using them).
 *
 * @param {Record<string, any>} shape  the zod shape object (field → zodType)
 * @param {Record<string, any>} args   the incoming arguments
 * @param {string} toolName            for the message prefix
 * @returns {Record<string, any>} args
 */
export function validateArgs(shape, args, toolName) {
  const a = args ?? {};
  const validKeys = Object.keys(shape);
  const validSet = new Set(validKeys);

  // 1) Unknown / misspelled params — the silent-drop footgun.
  for (const k of Object.keys(a)) {
    if (!validSet.has(k)) {
      const hint = suggestKey(k, validKeys);
      throw new Error(
        `${toolName}: unknown parameter '${k}'.` +
        (hint ? ` Did you mean '${hint}'?` : "") +
        ` Valid: ${validKeys.join(", ")}.`,
      );
    }
  }

  // 2) Per-field: enum membership + required presence + coarse type.
  for (const key of validKeys) {
    const zt = shape[key];
    const present = a[key] !== undefined && a[key] !== null;
    const optional = isOptionalZod(zt);
    if (!present) {
      if (!optional && !hasDefault(zt)) {
        throw new Error(`${toolName}: missing required parameter '${key}'. Valid params: ${validKeys.join(", ")}.`);
      }
      continue;
    }
    const opts = enumValues(unwrapZod(zt));
    if (opts && !opts.includes(a[key])) {
      throw new Error(
        `${toolName}: '${key}' must be one of: ${opts.join(" | ")} (got ${JSON.stringify(a[key])}).`,
      );
    }
  }
  return a;
}

/** Peel optional/default/nullable wrappers to reach the inner zod type. */
function unwrapZod(zt) {
  let t = zt;
  for (let i = 0; i < 6 && t?._def; i++) {
    const tn = t._def.typeName || t._def.type;
    if (tn === "ZodOptional" || tn === "optional" || tn === "ZodDefault" || tn === "default" ||
        tn === "ZodNullable" || tn === "nullable") {
      t = t._def.innerType ?? t._def.type ?? t.unwrap?.();
    } else break;
  }
  return t;
}

/** True if a zod type is optional (or nullable). */
function isOptionalZod(zt) {
  try { return zt?.isOptional?.() === true || zt?.isNullable?.() === true; }
  catch { return false; }
}

/** True if a zod type carries a default (so absence is fine). */
function hasDefault(zt) {
  let t = zt;
  for (let i = 0; i < 6 && t?._def; i++) {
    const tn = t._def.typeName || t._def.type;
    if (tn === "ZodDefault" || tn === "default") return true;
    if (tn === "ZodOptional" || tn === "optional" || tn === "ZodNullable" || tn === "nullable") {
      t = t._def.innerType ?? t._def.type ?? t.unwrap?.();
    } else break;
  }
  return false;
}
