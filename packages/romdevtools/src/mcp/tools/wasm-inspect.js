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
    "• 'read' {offset,length} / 'write' {offset,hex|base64} — peek/poke the cart's WASM linear heap at a RAW byte " +
    "offset (there's no emulated address space with named regions — it's the cart's own memory). Poke a value, step, " +
    "watch the framebuffer react. Note: raw offsets are opaque without symbols; you own the source, so this is a " +
    "supplement, not the primary debugger.\n" +
    "• 'save' — the cart's declared save-data bytes (savePtr/saveSize), to assert a game persisted what it should.\n" +
    "REFUSES on an emulator host (use disasm/symbols/memory there).",
    {
      op: z.enum(["conformance", "info", "exports", "read", "write", "save"])
        .describe("conformance = spec-validation verdict; info = running WCInfo; exports = module export list; read/write = cart heap at a raw byte offset; save = declared save-data bytes."),
      offset: z.number().int().min(0).optional().describe("op=read/write: byte offset into the cart's WASM linear memory."),
      length: z.number().int().min(1).optional().describe("op=read: number of bytes to read (default 16)."),
      hex: z.string().optional().describe("op=write: bytes as hex ('1A2B'; spaces/underscores/$ stripped)."),
      base64: z.string().optional().describe("op=write: bytes as base64 (alternative to hex)."),
      inline: z.boolean().default(false).describe(`op=read: for reads >${INLINE_HEX_LIMIT}B, return hex in the response anyway.`),
    },
    safeTool(async ({ op, offset, length, hex, base64, inline }) => {
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

      if (op === "read") {
        if (offset == null) throw new Error("wasm({op:'read'}): `offset` is required (raw byte offset into the cart heap).");
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
        if (offset == null) throw new Error("wasm({op:'write'}): `offset` is required.");
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
