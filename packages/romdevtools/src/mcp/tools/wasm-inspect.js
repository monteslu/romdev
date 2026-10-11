// wasm-inspect - the `wasm` tool: introspection for native-runtime hosts whose
// artifact is a real WebAssembly instance (wasmcart today). This is the axis a
// libretro emulator can't offer - the cart runs in V8, so we can validate its
// ABI/manifest conformance, read the running WCInfo, enumerate exports, and
// peek/poke the actual cart heap.
//
// Gated on getCapabilities().hasWasmIntrospection. Refuses SYMMETRICALLY on an
// emulator host (the mirror of how disasm/cheats refuse on wasmcart) so neither
// kind silently no-ops on the wrong tool.

import { getHost } from "../state.js";
import { jsonContent, safeTool, parseHexBytes } from "../util.js";

const INLINE_HEX_LIMIT = 4096;

/** A bytes field comes back from CartHost as a Uint8Array, which JSON turns
 *  into an object with one key per byte (a 256-byte command buffer printed
 *  as 256 lines). Render it as hex, plus the text up to the first NUL when
 *  that prefix is printable: most byte fields are strings. */
const BYTES_LIST_CAP = 256;
function renderBytes(v, cap = Infinity) {
  if (!v || !(v.bytes instanceof Uint8Array)) return v;
  const b = Buffer.from(v.bytes);
  const nul = b.indexOf(0);
  const head = b.subarray(0, nul < 0 ? b.length : nul);
  const printable = head.every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127));
  const { bytes: _b, ...rest } = v;
  if (b.length > cap) {
    // a listing of every field must stay readable: a 256 KB mailbox printed
    // as hex overflowed tool output; read it by name for the full contents
    return { ...rest, length: b.length, truncated: true, ...(printable ? { text: head.subarray(0, cap).toString("latin1") } : { hex: b.subarray(0, cap).toString("hex") }),
      note: `${b.length} bytes: read it with wasm({op:'read', name}) for the whole field` };
  }
  return { ...rest, length: b.length, hex: b.toString("hex"), ...(printable ? { text: head.toString("latin1") } : {}) };
}

/** Decode a named debug field to {value} or {values}/{bytes}, dropping the
 *  redundant name/type the caller already has from the field descriptor. */
function decodeName(host, fieldName) {
  const v = renderBytes(host.readDebugValue(fieldName), BYTES_LIST_CAP); /* the debugState listing */
  const { name: _n, type: _t, ...rest } = v;
  return rest;
}

function requireWasmHost(sessionKey) {
  const host = getHost(sessionKey);
  const caps = host.getCapabilities?.();
  if (!caps?.hasWasmIntrospection) {
    throw new Error(
      `wasm({...}): this session's host (${caps?.kind ?? "unknown"}) is not a WASM-runtime cart. ` +
      "The `wasm` tool inspects a real WebAssembly instance (wasmcart). For an emulated core use " +
      "disasm/symbols/memory/cheats instead.",
    );
  }
  return host;
}

export function registerWasmInspectTools(server, z, sessionKey) {
  server.tool(
    "wasm",
    "Inspect a WASM-runtime cart (wasmcart) - the introspection an emulator can't give, because the cart is a real " +
    "WebAssembly instance in V8. `op`:\n" +
    "• 'conformance' - the 'won't load / loaded but wrong, WHY?' verdict. Validates the cart against the wasmcart " +
    "spec (required exports wc_get_info/wc_init/wc_render present? manifest abi vs the running instance? declared " +
    "resolution vs actual? manifest shape) → {conforms, issues[]} with each issue naming the fix. The one failure " +
    "you can't diagnose from your own source (the code compiled; the cart still won't run). Language-agnostic - the " +
    "wasmcart analogue of 'is this a valid iNES header'.\n" +
    "• 'info' - the running instance's WCInfo (abi, width, height, fbPtr, savePtr/saveSize): manifest-vs-reality.\n" +
    "• 'exports' - the module's exported functions/globals/memory/tables (+ abiComplete): 'did my build produce the " +
    "right ABI surface'.\n" +
    "• 'debugState' - the cart's OPT-IN named debug table (wasmcart debug ABI): the values the cart chose to expose " +
    "BY NAME (player_x, hp, ...), each with type + current value. The source-level view an emulator can't give - reading " +
    "`player_x` instead of a raw offset. Only present when the cart set WC_FLAG_DEBUG + exports wc_debug_state(); " +
    "otherwise says so.\n" +
    "• 'read' {name} OR {offset,length} / 'write' {name,value} OR {name,hex} (a bytes field) OR {offset,hex|base64} - with `name`, resolves a debug " +
    "field to its offset+type and reads/writes it DECODED (the preferred path when the cart exposes debug state). With " +
    "`offset`, peeks/pokes the RAW heap byte-wise (the fallback: raw offsets are opaque without the debug table, and " +
    "you own the source, so prefer `name`).\n" +
    "• 'events' - DRAIN the frame-stamped debug event trace: wc_log lines ({frame, text}) and wc_debug_mark(id) " +
    "annotations ({frame, id}) the cart emitted since the last drain. The navigable timeline of a run ('level " +
    "loaded at frame 312') - pull-model, clears on read.\n" +
    "• 'save' - the cart's declared save-data bytes (savePtr/saveSize), to assert a game persisted what it should.\n" +
    "• 'command' {text} - the DEBUG CHANNEL: ask a running cart a question it answers itself (scene tree, get/set a " +
    "property by path, spawn/free nodes, stats...). Convention, no ABI change: the cart exposes bytes fields `dbg.cmd` " +
    "and `dbg.reply` plus u32 fields `dbg.cmd_seq`, `dbg.reply_seq`, `dbg.reply_len` in its debug table; this op writes " +
    "`text` to dbg.cmd, bumps dbg.cmd_seq, steps frames until dbg.reply_seq catches up (the cart answers at the start of " +
    "its next frame, so ONE frame runs per command; pause the game first if that matters), and returns the reply " +
    "(parsed as JSON when it is JSON). `help` lists a cart's commands. Only carts built with a debug channel answer.\n" +
    "REFUSES on an emulator host (use disasm/symbols/memory there).",
    {
      op: z.enum(["conformance", "info", "exports", "debugState", "events", "read", "write", "save", "command"])
        .describe("conformance = spec-validation verdict; info = running WCInfo; exports = module export list; debugState = the cart's opt-in named debug fields; events = drain the frame-stamped wc_log/wc_debug_mark trace; read/write = a named debug field (`name`) OR the raw heap (`offset`); save = declared save-data bytes; command = send `text` over the cart's debug channel and return its reply."),
      text: z.string().optional().describe("op=command: the request, e.g. 'tree', 'get /root/Level/Player position', 'set /root/Level/Player position vec3(0, 2, 0)', 'help'."),
      maxFrames: z.number().int().min(1).max(600).default(8).describe("op=command: frames to step at most while waiting for the reply."),
      name: z.string().optional().describe("op=read/write: a debug field name from debugState (resolves to offset+type, reads/writes DECODED). Preferred over `offset` when the cart exposes debug state."),
      value: z.number().optional().describe("op=write: the value to write to the named scalar debug field (use with `name`)."),
      offset: z.number().int().min(0).optional().describe("op=read/write: RAW byte offset into the cart's WASM linear memory (fallback when there's no named field)."),
      length: z.number().int().min(1).optional().describe("op=read: number of bytes to read (default 16)."),
      hex: z.string().optional().describe("op=write: bytes as hex ('1A2B'; spaces/underscores/$ stripped) - raw-offset write."),
      base64: z.string().optional().describe("op=write: bytes as base64 (alternative to hex) - raw-offset write."),
      inline: z.boolean().default(false).describe(`op=read: for reads >${INLINE_HEX_LIMIT}B, return hex in the response anyway.`),
    },
    safeTool(async ({ op, name, value, offset, length, hex, base64, inline, text, maxFrames }) => {
      const host = requireWasmHost(sessionKey);

      if (op === "command") {
        if (text == null) throw new Error("wasm({op:'command'}): pass `text` (try 'help').");
        const fields = host.readDebugState?.() ?? [];
        const f = (n) => fields.find((x) => x.name === n);
        const missing = ["dbg.cmd", "dbg.cmd_seq", "dbg.reply", "dbg.reply_seq", "dbg.reply_len"].filter((n) => !f(n));
        if (missing.length) {
          throw new Error(`wasm({op:'command'}): this cart has no debug channel (missing ${missing.join(", ")} in its debug table). The cart has to be built with its debug channel enabled.`);
        }
        const cmd = f("dbg.cmd");
        const bytes = Buffer.from(text + "\0", "utf8");
        if (bytes.length > cmd.len) throw new Error(`wasm({op:'command'}): request is ${bytes.length} bytes; the cart's dbg.cmd holds ${cmd.len}.`);
        const seq = ((host.readDebugValue("dbg.cmd_seq").value >>> 0) + 1) >>> 0;
        host.writeMemory(cmd.valuePtr, new Uint8Array(bytes));
        host.writeDebugValue("dbg.cmd_seq", seq);
        let frames = 0;
        while ((host.readDebugValue("dbg.reply_seq").value >>> 0) !== seq && frames < maxFrames) {
          await host.stepFrames(1);
          frames++;
        }
        if ((host.readDebugValue("dbg.reply_seq").value >>> 0) !== seq) {
          throw new Error(`wasm({op:'command'}): no reply after ${frames} frames (is the cart paused by the host, or not processing its debug channel?).`);
        }
        const len = host.readDebugValue("dbg.reply_len").value >>> 0;
        const reply = Buffer.from(host.readMemory(f("dbg.reply").valuePtr, Math.min(len, f("dbg.reply").len))).toString("utf8");
        let parsed;
        try { parsed = JSON.parse(reply); } catch { parsed = undefined; }
        return jsonContent(parsed !== undefined ? { framesRun: frames, reply: parsed } : { framesRun: frames, reply });
      }

      if (op === "conformance") {
        return jsonContent({
          ...host.checkConformance(),
          note: "conforms:false means a `severity:'error'` issue (won't run) - fix those first. warns are cosmetic/latent. Each issue's message names the fix.",
        });
      }

      if (op === "info") {
        const info = host.getInfo();
        if (!info) throw new Error("wasm({op:'info'}): no WCInfo - is a cart loaded and stepped once?");
        return jsonContent({ info, manifest: host.getManifest?.() ?? null });
      }

      if (op === "exports") {
        const exports = host.wasmExports();
        const names = new Set(exports.map((e) => e.name));
        const required = ["wc_get_info", "wc_init", "wc_render"];
        return jsonContent({
          count: exports.length,
          abiComplete: required.every((r) => names.has(r)),
          missingRequired: required.filter((r) => !names.has(r)),
          exports,
        });
      }

      if (op === "debugState") {
        const fields = host.readDebugState?.();
        if (!fields) {
          return jsonContent({
            hasDebugState: false,
            note: "this cart exposes no named debug state (it didn't set WC_FLAG_DEBUG / export wc_debug_state, or the wasmcart build predates the debug ABI). Use wasm({op:'read', offset}) for raw heap access.",
          });
        }
        // Decode each field's current value for a one-call snapshot.
        const values = fields.map((f) => {
          try { return { ...f, ...decodeName(host, f.name) }; }
          catch { return { ...f, error: "decode failed" }; }
        });
        return jsonContent({ hasDebugState: true, count: fields.length, fields: values,
          note: "the cart's opt-in named state. read/write a field by name: wasm({op:'read', name:'player_x'})." });
      }

      if (op === "events") {
        if (typeof host.drainDebugEvents !== "function" || !host.getCapabilities().hasDebugEvents) {
          return jsonContent({
            hasDebugEvents: false,
            note: "this wasmcart build has no debug event capture (needs wasmcart >= 0.5.0). wc_log still prints to the server console.",
          });
        }
        const { log, marks } = host.drainDebugEvents();
        return jsonContent({
          hasDebugEvents: true, log, marks,
          note: "drained (rings are now empty). marks are cart-authored wc_debug_mark(id) annotations; log is captured wc_log text. Both stamped with the frame they fired on.",
        });
      }

      if (op === "read" && name != null) {
        return jsonContent({ ...renderBytes(host.readDebugValue(name)) });
      }
      if (op === "write" && name != null && value == null && (hex != null || base64 != null)) {
        // A bytes field written by name: the descriptor bounds the write, so a
        // harness never needs the raw offset (which moves on every rebuild).
        const field = (host.readDebugState?.() ?? []).find((f) => f.name === name);
        if (!field) throw new Error(`wasm({op:'write', name}): the cart has no debug field '${name}'.`);
        if (field.type !== 8) {
          throw new Error(`wasm({op:'write', name:'${name}'}): hex/base64 writes need a bytes field; '${name}' is ${field.typeName ?? field.type}, so pass \`value\`.`);
        }
        const buf = hex != null ? parseHexBytes(hex, "wasm write: hex") : new Uint8Array(Buffer.from(base64, "base64"));
        if (buf.length > field.len) {
          throw new Error(`wasm({op:'write', name:'${name}'}): ${buf.length} bytes exceeds the field's ${field.len}.`);
        }
        const n = host.writeMemory(field.valuePtr, buf);
        return jsonContent({ name, wrote: n, atOffset: field.valuePtr, note: "wrote the named bytes field; step a frame to see it take effect." });
      }
      if (op === "write" && name != null) {
        if (value == null) throw new Error("wasm({op:'write', name}): `value` is required for a named scalar write (or `hex`/`base64` for a bytes field).");
        const at = host.writeDebugValue(name, value);
        return jsonContent({ name, wrote: value, atOffset: at, note: "wrote the named debug field; step a frame to see it take effect." });
      }

      if (op === "read") {
        if (offset == null) throw new Error("wasm({op:'read'}): pass `name` (a debug field) or `offset` (raw byte offset into the cart heap).");
        const len = length ?? 16;
        const bytes = host.readMemory(offset, len);
        const hexStr = Buffer.from(bytes).toString("hex");
        if (bytes.length > INLINE_HEX_LIMIT && !inline) {
          return jsonContent({
            offset, length: bytes.length,
            note: `${bytes.length} bytes exceeds the ${INLINE_HEX_LIMIT}B inline cap - pass inline:true to return the hex anyway.`,
            wasmMemoryBytes: host.wasmMemorySize(),
          });
        }
        return jsonContent({ offset, length: bytes.length, hex: hexStr });
      }

      if (op === "write") {
        if (offset == null) throw new Error("wasm({op:'write'}): pass `name`+`value` (a debug field) or `offset`+`hex`/`base64` (raw heap).");
        let buf;
        if (hex != null) buf = parseHexBytes(hex, "wasm write: hex");
        else if (base64 != null) buf = new Uint8Array(Buffer.from(base64, "base64"));
        else throw new Error("wasm({op:'write'}): provide `hex` or `base64`.");
        const n = host.writeMemory(offset, buf);
        return jsonContent({ offset, wrote: n, note: "poked the live cart heap; step a frame to see it take effect." });
      }

      if (op === "save") {
        const save = host.getSaveData();
        if (!save || !save.length) {
          return jsonContent({ hasSaveData: false, note: "the cart declared no save data (savePtr/saveSize = 0), or nothing has been written yet." });
        }
        return jsonContent({
          hasSaveData: true,
          length: save.length,
          hex: save.length <= INLINE_HEX_LIMIT ? Buffer.from(save).toString("hex") : undefined,
          ...(save.length > INLINE_HEX_LIMIT ? { note: `${save.length}B save data - too large to inline.` } : {}),
        });
      }

      throw new Error(`wasm: unknown op '${op}'.`);
    }),
  );
}
