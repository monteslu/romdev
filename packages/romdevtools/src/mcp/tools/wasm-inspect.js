// wasm-inspect — the `wasm` tool: introspection for native-runtime hosts whose
// artifact is a real WebAssembly instance (wasmcart today). This is the axis a
// libretro emulator can't offer — the cart runs in V8, so we can validate its
// ABI/manifest conformance, read the running WCInfo, enumerate exports, and
// peek/poke the actual cart heap.
//
// Gated on getCapabilities().hasWasmIntrospection. Refuses SYMMETRICALLY on an
// emulator host (the mirror of how disasm/cheats refuse on wasmcart) so neither
// kind silently no-ops on the wrong tool.

import { getHost } from "../state.js";
import { jsonContent, safeTool, parseHexBytes } from "../util.js";

const INLINE_HEX_LIMIT = 4096;

/** Decode a named debug field to {value} or {values}/{bytes}, dropping the
 *  redundant name/type the caller already has from the field descriptor. */
function decodeName(host, fieldName) {
  const v = host.readDebugValue(fieldName);
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
    "Inspect a WASM-runtime cart (wasmcart) — the introspection an emulator can't give, because the cart is a real " +
    "WebAssembly instance in V8. `op`:\n" +
    "• 'conformance' — the 'won't load / loaded but wrong, WHY?' verdict. Validates the cart against the wasmcart " +
    "spec (required exports wc_get_info/wc_init/wc_render present? manifest abi vs the running instance? declared " +
    "resolution vs actual? manifest shape) → {conforms, issues[]} with each issue naming the fix. The one failure " +
    "you can't diagnose from your own source (the code compiled; the cart still won't run). Language-agnostic — the " +
    "wasmcart analogue of 'is this a valid iNES header'.\n" +
    "• 'info' — the running instance's WCInfo (abi, width, height, fbPtr, savePtr/saveSize): manifest-vs-reality.\n" +
    "• 'exports' — the module's exported functions/globals/memory/tables (+ abiComplete): 'did my build produce the " +
    "right ABI surface'.\n" +
    "• 'debugState' — the cart's OPT-IN named debug table (wasmcart debug ABI): the values the cart chose to expose " +
    "BY NAME (player_x, hp, …), each with type + current value. The source-level view an emulator can't give — reading " +
    "`player_x` instead of a raw offset. Only present when the cart set WC_FLAG_DEBUG + exports wc_debug_state(); " +
    "otherwise says so.\n" +
    "• 'read' {name} OR {offset,length} / 'write' {name,value} OR {offset,hex|base64} — with `name`, resolves a debug " +
    "field to its offset+type and reads/writes it DECODED (the preferred path when the cart exposes debug state). With " +
    "`offset`, peeks/pokes the RAW heap byte-wise (the fallback: raw offsets are opaque without the debug table, and " +
    "you own the source, so prefer `name`).\n" +
    "• 'events' — DRAIN the frame-stamped debug event trace: wc_log lines ({frame, text}) and wc_debug_mark(id) " +
    "annotations ({frame, id}) the cart emitted since the last drain. The navigable timeline of a run ('level " +
    "loaded at frame 312') — pull-model, clears on read. wasmcart 0.5.0+.\n" +
    "• 'save' — the cart's declared save-data bytes (savePtr/saveSize), to assert a game persisted what it should.\n" +
    "REFUSES on an emulator host (use disasm/symbols/memory there).",
    {
      op: z.enum(["conformance", "info", "exports", "debugState", "events", "read", "write", "save"])
        .describe("conformance = spec-validation verdict; info = running WCInfo; exports = module export list; debugState = the cart's opt-in named debug fields; events = drain the frame-stamped wc_log/wc_debug_mark trace; read/write = a named debug field (`name`) OR the raw heap (`offset`); save = declared save-data bytes."),
      name: z.string().optional().describe("op=read/write: a debug field name from debugState (resolves to offset+type, reads/writes DECODED). Preferred over `offset` when the cart exposes debug state."),
      value: z.number().optional().describe("op=write: the value to write to the named scalar debug field (use with `name`)."),
      offset: z.number().int().min(0).optional().describe("op=read/write: RAW byte offset into the cart's WASM linear memory (fallback when there's no named field)."),
      length: z.number().int().min(1).optional().describe("op=read: number of bytes to read (default 16)."),
      hex: z.string().optional().describe("op=write: bytes as hex ('1A2B'; spaces/underscores/$ stripped) — raw-offset write."),
      base64: z.string().optional().describe("op=write: bytes as base64 (alternative to hex) — raw-offset write."),
      inline: z.boolean().default(false).describe(`op=read: for reads >${INLINE_HEX_LIMIT}B, return hex in the response anyway.`),
    },
    safeTool(async ({ op, name, value, offset, length, hex, base64, inline }) => {
      const host = requireWasmHost(sessionKey);

      if (op === "conformance") {
        return jsonContent({
          ...host.checkConformance(),
          note: "conforms:false means a `severity:'error'` issue (won't run) — fix those first. warns are cosmetic/latent. Each issue's message names the fix.",
        });
      }

      if (op === "info") {
        const info = host.getInfo();
        if (!info) throw new Error("wasm({op:'info'}): no WCInfo — is a cart loaded and stepped once?");
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
        return jsonContent({ ...host.readDebugValue(name) });
      }
      if (op === "write" && name != null) {
        if (value == null) throw new Error("wasm({op:'write', name}): `value` is required for a named scalar write.");
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
            note: `${bytes.length} bytes exceeds the ${INLINE_HEX_LIMIT}B inline cap — pass inline:true to return the hex anyway.`,
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
          ...(save.length > INLINE_HEX_LIMIT ? { note: `${save.length}B save data — too large to inline.` } : {}),
        });
      }

      throw new Error(`wasm: unknown op '${op}'.`);
    }),
  );
}
