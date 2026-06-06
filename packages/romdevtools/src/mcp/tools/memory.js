import { getHost } from "../state.js";
import { MemoryRegionToRetro } from "../../host/types.js";
import { jsonContent, safeTool, textContent, writeOutput } from "../util.js";
import { classifyBytes } from "./classify-region.js";
import { clusterChanges } from "./diff-cluster.js";

// Small reads stay inline (hex) for ergonomics; large reads must go to disk
// (raw bytes) unless inline:true. The common case — peeking a few bytes of
// RAM/OAM/palette — never requires a path.
const INLINE_HEX_LIMIT = 4096;

// Derive the allowed-region list from the host's authoritative map so
// new regions added to host/types.js automatically flow through to the
// MCP tool whitelist. Prior gotcha: SNES regions were added in
// types.js but the MCP whitelist was hardcoded NES-only, blocking
// agents from calling readMemory("snes_oam") even though the host
// supported it. Single source of truth fixes the class.
const REGIONS = /** @type {[string, ...string[]]} */ (Object.keys(MemoryRegionToRetro));

// Per-region byte-order + word-size metadata, surfaced in the
// readMemory response so agents don't burn time figuring out byte
// order empirically. Each platform's CPU endianness drives this:
//   - NES (6502)         : little-endian
//   - SNES (65816)       : little-endian
//   - Genesis (68000)    : big-endian
//   - GB / GBC (LR35902) : little-endian
//   - Atari (6502/6507)  : little-endian
// For sub-CPUs the rule follows that chip: SNES SPC700 = little,
// Genesis Z80 = little. Generic regions (system_ram) inherit their
// platform's CPU endianness — they hold whatever the CPU wrote.
//
// "wordSize" hints how to interpret multi-byte reads: 1 = bytes
// (e.g. NES OAM), 2 = 16-bit words (e.g. Genesis CRAM, SNES CGRAM).
const REGION_INFO = {
  // Generic. The endianness depends on the loaded platform — leave
  // unset and let the host fill it in based on host.status.platform.
  system_ram:        { wordSize: 1 },
  save_ram:          { wordSize: 1 },
  video_ram:         { wordSize: 1 },
  rtc:               { wordSize: 1 },
  // NES (fceumm patch) — little-endian, byte-oriented.
  nes_nametables:    { endianness: "little", wordSize: 1, note: "2KB CIRAM (NES nametables)" },
  nes_palette:       { endianness: "little", wordSize: 1, note: "32 bytes, BG palette $00-$0F + sprite palette $10-$1F" },
  nes_oam:           { endianness: "little", wordSize: 1, note: "256B = 64 sprites × 4 bytes {y, tile, attr, x}" },
  nes_chr:           { endianness: "little", wordSize: 1, note: "8KB CHR via VPage[0..7] — refreshed on read" },
  // SNES (snes9x patch) — little-endian (65816). CGRAM is BGR555 words.
  snes_oam:          { endianness: "little", wordSize: 1, note: "544B = 512B low table (128 sprites × 4) + 32B hi table (2 bits/sprite)" },
  snes_cgram:        { endianness: "little", wordSize: 2, note: "512B = 256 colors × uint16 BGR555 (bit 15 unused, bits 10-14 B, 5-9 G, 0-4 R)" },
  snes_aram:         { endianness: "little", wordSize: 1, note: "64KB SPC700 audio CPU RAM" },
  snes_fillram:      { endianness: "little", wordSize: 1, note: "32KB PPU/DMA register shadow at $00:2000+" },
  // Genesis (gpgx patch) — BIG-ENDIAN (68000 chip). CRAM is BGR words.
  genesis_cram:      { endianness: "big",    wordSize: 2, note: "128B = 64 colors × uint16 big-endian, 9-bit effective (bits 1-3 R, 5-7 G, 9-11 B)" },
  genesis_vsram:     { endianness: "big",    wordSize: 2, note: "128B vertical scroll table (per-cell or per-line depending on VDP reg $0B)" },
  genesis_vdp_regs:  { endianness: "big",    wordSize: 1, note: "32 VDP registers $00-$1F (write-only on hardware; this is gpgx's mirror)" },
  genesis_z80_ram:   { endianness: "little", wordSize: 1, note: "8KB Z80 sound CPU RAM (Z80 is little-endian even though main CPU is big)" },
  genesis_m68k:      { endianness: "little", wordSize: 4, note: "Live m68ki_cpu_core struct from gpgx. Host-side fields are wasm32 native LE. Use getCPUState({platform:'genesis'}) instead of decoding by hand." },
  genesis_ym2612:    { endianness: "little", wordSize: 1, note: "YM2612 internal context snapshot (gpgx-private layout — diff-only)" },
  genesis_psg:       { endianness: "little", wordSize: 1, note: "PSG (SN76489) internal context snapshot — parse via getAudioState({chip:'psg'})" },
};

// Per-platform fallback endianness for generic regions (system_ram etc).
// Driven by the loaded platform's main CPU.
function genericEndianness(platform) {
  switch (platform) {
    case "genesis":  return "big";
    case "snes":
    case "nes":
    case "c64":
    case "atari2600":
    case "atari7800":
    case "lynx":
    case "gb":
    case "gbc":
    case "sms":
    case "gg":       return "little";
    default:         return "unknown";
  }
}

// ── memory op implementations ───────────────────────────────────────────
// Each function is the body of one former narrow tool, verbatim. The `memory`
// router dispatches on `op`. They share the module-scope helpers below.

async function memRead(sessionKey, { region, offset = 0, length, offsets, outputPath, inline }) {
      const host = getHost(sessionKey);
      const info0 = REGION_INFO[region] ?? {};
      const endianness0 = info0.endianness ?? genericEndianness(host.status.platform);

      // BATCH path: read each requested spot and return them in order. Always
      // inline (these are small, scattered reads — the whole point is one call).
      if (offsets && offsets.length) {
        const reads = offsets.map((o) => {
          const off = typeof o === "number" ? o : o.offset;
          const len = typeof o === "number" ? (length ?? 1) : (o.length ?? 1);
          const b = host.readMemory(region, off, len);
          return {
            offset: off,
            length: b.length,
            hex: Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""),
          };
        });
        return jsonContent({
          region,
          endianness: endianness0,
          wordSize: info0.wordSize ?? 1,
          reads,
        });
      }

      const bytes = host.readMemory(region, offset, length ?? 1);
      // Attach endianness + wordSize from the region info table so the
      // agent doesn't have to figure byte order out empirically. For
      // generic regions (system_ram etc) fall back to the loaded
      // platform's CPU endianness.
      const info = REGION_INFO[region] ?? {};
      const endianness = info.endianness ?? genericEndianness(host.status.platform);
      // Genesis VRAM is stored by genesis-plus-gx as 16-bit words in HOST
      // (little-endian) byte order, so these raw bytes have each word's two
      // bytes swapped vs the VDP-logical layout — a raw read is NOT a direct
      // tile/pixel map. (The VDP un-swaps when rendering, so the screen is
      // correct.) Use getTile (logicalPixels:true, the default) to decode tiles
      // in render order instead of un-swapping by hand.
      let note = info.note ?? null;
      if (region === "video_ram" && host.status.platform === "genesis") {
        note = (note ? note + " " : "") +
          "GENESIS: these are RAW host-LE bytes — each 16-bit VRAM word's two bytes are SWAPPED " +
          "vs the VDP-logical order, so this is not a direct tile/pixel map. getTile({logicalPixels:true}) " +
          "decodes tiles in render order for you.";
      }
      const meta = {
        region,
        offset,
        length: bytes.length,
        endianness,
        wordSize: info.wordSize ?? 1,
        note,
      };
      // Large reads: path-or-inline. Write the RAW bytes to disk (not hex) so
      // the artifact is directly usable; inline returns the hex string.
      if (bytes.length > INLINE_HEX_LIMIT && !inline) {
        const { path, bytes: written } = writeOutput(bytes, { outputPath, what: `readMemory(${region})` });
        return jsonContent({ ...meta, path, bytes: written });
      }
      // Small read WITH an explicit outputPath: honor it — write the raw bytes
      // to disk AND still return the hex inline (small, useful). The intent of
      // passing outputPath is unambiguous; silently ignoring it broke the
      // "snapshot RAM to a file, then diff two files" workflow.
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      if (outputPath) {
        const { path, bytes: written } = writeOutput(bytes, { outputPath, what: `readMemory(${region})` });
        return jsonContent({ ...meta, path, bytes: written, hex });
      }
      return jsonContent({ ...meta, hex });
}

async function memWrite(sessionKey, { region, offset = 0, hex, base64, data, bytes: bytesArg }) {
      if (data !== undefined || bytesArg !== undefined) {
        const wrongName = data !== undefined ? "data" : "bytes";
        const hint = Array.isArray(data ?? bytesArg)
          ? `Array payloads aren't accepted. Convert to a hex string: hex: bytes.map(b => b.toString(16).padStart(2,'0')).join('')`
          : "Pass the payload as `hex` (string) or `base64` (string).";
        throw new Error(
          `writeMemory: '${wrongName}' is not a valid arg. ${hint} ` +
          `Example: writeMemory({region:"${region}", offset:${offset}, hex:"42"})`
        );
      }
      let buf;
      if (hex) {
        if (hex.length % 2 !== 0) throw new Error("writeMemory: hex string must have even length");
        if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("writeMemory: hex string contains non-hex characters");
        buf = new Uint8Array(hex.length / 2);
        for (let i = 0; i < buf.length; i++) {
          buf[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
      } else if (base64) {
        buf = new Uint8Array(Buffer.from(base64, "base64"));
      } else {
        throw new Error(
          "writeMemory: missing payload. Pass `hex` (e.g. hex:'42') or `base64`. " +
          "If you intended to pass an array, convert it to hex: " +
          "bytes.map(b => b.toString(16).padStart(2,'0')).join('')"
        );
      }
      getHost(sessionKey).writeMemory(region, offset, buf);
      return textContent(`wrote ${buf.length} bytes to ${region}+${offset}`);
}

async function memReadCart(sessionKey, { offset = 0, length = 16, outputPath, inline }) {
      const host = getHost(sessionKey);
      const rom = host.getCartRom();
      if (offset >= rom.bytes.length) {
        throw new Error(`readCartRom: offset ${offset} is past the end of the ${rom.platform} ROM (size ${rom.bytes.length}, header skipped ${rom.headerSkipped}).`);
      }
      const end = Math.min(offset + length, rom.bytes.length);
      const slice = rom.bytes.subarray(offset, end);
      const meta = {
        platform: rom.platform,
        offset,
        length: slice.length,
        romSize: rom.bytes.length,
        headerSkipped: rom.headerSkipped,
        mapped: rom.mapped,
        ...(rom.base ? { cpuAddress: "0x" + (rom.base + offset).toString(16).toUpperCase() } : {}),
        note: rom.note,
      };
      if (slice.length > INLINE_HEX_LIMIT && !inline) {
        const { path, bytes: written } = writeOutput(slice, { outputPath, what: "readCartRom" });
        return jsonContent({ ...meta, path, bytes: written });
      }
      const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join("");
      if (outputPath) {
        const { path, bytes: written } = writeOutput(slice, { outputPath, what: "readCartRom" });
        return jsonContent({ ...meta, path, bytes: written, hex });
      }
      return jsonContent({ ...meta, hex });
}

// ── snapshotMemory / diffMemory — "which bytes changed across this event?" ──
async function memSnapshot(sessionKey, { region, name = "default", offset = 0, length }) {
      const host = getHost(sessionKey);
      const bytes = host.readMemory(region, offset, length ?? regionLength(host, region, offset));
      memSnapshots(sessionKey).set(snapKey(region, name), { offset, bytes: Uint8Array.from(bytes) });
      return jsonContent({ region, name, offset, length: bytes.length, note: "Baseline captured — trigger your event, then memory({op:'diff', region, name}) for the changed bytes." });
}

async function memDiff(sessionKey, { region, name = "default", view = "summary", maxChanges = 4096, maxClusters = 64, gap = 4 }) {
      const host = getHost(sessionKey);
      const snap = memSnapshots(sessionKey).get(snapKey(region, name));
      if (!snap) throw new Error(`memory({op:'diff'}): no snapshot named '${name}' for region '${region}'. Call memory({op:'snapshot', region, name}) first.`);
      const now = host.readMemory(region, snap.offset, snap.bytes.length);

      // Collect changed offsets once.
      const changedOffsets = [];
      for (let i = 0; i < snap.bytes.length; i++) if (snap.bytes[i] !== now[i]) changedOffsets.push(i);
      const changedCount = changedOffsets.length;

      if (view === "raw") {
        const changes = changedOffsets.slice(0, maxChanges).map((i) => ({
          offset: "0x" + (snap.offset + i).toString(16).toUpperCase(),
          offsetDec: snap.offset + i,
          before: snap.bytes[i].toString(16).padStart(2, "0"),
          after: now[i].toString(16).padStart(2, "0"),
        }));
        return jsonContent({
          region, name, view, baseOffset: snap.offset, length: snap.bytes.length,
          changedCount, changes,
          ...(changedCount > changes.length ? { truncated: true, note: `${changedCount} bytes changed; showing first ${changes.length} (raise maxChanges).` } : {}),
        });
      }

      // SUMMARY: cluster adjacent changes (within `gap`) into ranges + stride.
      const { clusters, stride } = clusterChanges(changedOffsets.map((i) => snap.offset + i), { gap });
      const strideNote = stride !== null
        ? `${clusters.length} change-islands evenly spaced at stride 0x${stride.toString(16)} — likely a struct/entity ARRAY (each island = one record's changed fields).`
        : null;
      const out = clusters.slice(0, maxClusters).map((c) => ({
        start: "0x" + c.startDec.toString(16).toUpperCase(),
        end: "0x" + c.endDec.toString(16).toUpperCase(),
        span: c.endDec - c.startDec + 1,
        bytes: c.bytes,
      }));
      return jsonContent({
        region, name, view, baseOffset: snap.offset, length: snap.bytes.length,
        changedCount, clusterCount: clusters.length,
        clusters: out,
        ...(stride !== null ? { stride: "0x" + stride.toString(16), strideHint: strideNote } : {}),
        ...(clusters.length > out.length ? { truncated: true } : {}),
        note: changedCount === 0
          ? "Nothing changed."
          : `${changedCount} bytes changed in ${clusters.length} cluster(s). ` +
            (stride !== null ? strideNote + " " : "") +
            "Use view:'raw' for exact before/after bytes (or narrow with a tighter event window). For 'find the address of value X' use memory({op:'search'}), not diff.",
      });
}

// diffState lives in the `state` tool (state({op:'diff'})).

// ── classifyRegion — "what kind of data is at this offset?" ──────────────
async function memClassify(sessionKey, { region = "system_ram", offset = 0, length = 256 }) {
      const host = getHost(sessionKey);
      const bytes = host.readMemory(region, offset, length);
      const cls = classifyBytes(bytes, { bigEndian: genericEndianness(host.status.platform) === "big" });
      return jsonContent({ region, offset: "0x" + offset.toString(16), length: bytes.length, ...cls });
}

// ── searchValue / searchNext — the iterative RAM value search (Cheat Engine /
//    RetroArch cheat-search workflow). THE primitive for "the screen shows X;
//    find its RAM address." Seed with op:'search', then narrow each time the
//    value changes with op:'searchNext' (compare:'eq'|'changed'|'unchanged'|'gt'|'lt'|'inc'|'dec').
//    The candidate list lives per session (keyed by `name`); each narrow reads
//    the region fresh and keeps only candidates that still satisfy the compare.
async function memSearch(sessionKey, { value, size = 1, region = "system_ram", name = "default", maxCandidates = 64 }) {
      const host = getHost(sessionKey);
      const info = REGION_INFO[region] ?? {};
      const little = (info.endianness ?? genericEndianness(host.status.platform)) !== "big";
      const buf = host.readMemory(region, 0, regionLength(host, region, 0));
      const read = (i) => readUint(buf, i, size, little);
      const candidates = [];
      for (let i = 0; i + size <= buf.length; i++) {
        if (read(i) === (value >>> 0)) candidates.push(i);
      }
      searchSessions(sessionKey).set(name, { region, size, little, addrs: Uint32Array.from(candidates) });
      return jsonContent({
        searchId: name, region, size,
        count: candidates.length,
        candidates: candidates.slice(0, maxCandidates).map((a) => "0x" + a.toString(16)),
        note: candidates.length === 0
          ? "0 matches — wrong size? (try size:2 for a score). Or the value isn't in this region (try a different region) or is stored offset/encoded."
          : candidates.length === 1
          ? "1 candidate — likely THE address. Confirm with memory({op:'write', region, offset, hex}) and watch the screen."
          : "Make the value change in-game, then memory({op:'searchNext', name, compare:'eq', value:<new>}) to narrow. Repeat until 1-2 remain.",
      });
}

async function memSearchNext(sessionKey, { compare, value, name = "default", maxCandidates = 64 }) {
      const host = getHost(sessionKey);
      const s = searchSessions(sessionKey).get(name);
      if (!s) throw new Error(`memory({op:'searchNext'}): no active search named '${name}'. Call memory({op:'search', value, name}) first.`);
      if ((compare === "eq" || compare === "gt" || compare === "lt") && value === undefined) {
        throw new Error(`searchNext: compare '${compare}' needs a \`value\` (the number now on screen).`);
      }
      const buf = host.readMemory(s.region, 0, regionLength(host, s.region, 0));
      const read = (i) => readUint(buf, i, s.size, s.little);
      const v = (value ?? 0) >>> 0;
      const kept = [];
      for (const a of s.addrs) {
        const cur = read(a);
        const prev = s.prev ? s.prev.get(a) : undefined;
        let ok = false;
        switch (compare) {
          case "eq":        ok = cur === v; break;
          case "gt":        ok = cur > v; break;
          case "lt":        ok = cur < v; break;
          case "changed":   ok = prev !== undefined && cur !== prev; break;
          case "unchanged": ok = prev !== undefined && cur === prev; break;
          case "inc":       ok = prev !== undefined && cur > prev; break;
          case "dec":       ok = prev !== undefined && cur < prev; break;
        }
        if (ok) kept.push(a);
      }
      // Remember this read so the next compare:'changed'/'inc'/'dec' has a baseline.
      const prevMap = new Map();
      for (const a of kept) prevMap.set(a, read(a));
      s.addrs = Uint32Array.from(kept);
      s.prev = prevMap;
      searchSessions(sessionKey).set(name, s);
      return jsonContent({
        searchId: name, compare, count: kept.length,
        candidates: kept.slice(0, maxCandidates).map((a) => "0x" + a.toString(16) + "=" + read(a)),
        note: kept.length === 0
          ? "0 left — narrowed too far (wrong op, or the value moved between reads). Re-seed with searchValue."
          : kept.length <= 2
          ? "Down to 1-2 — confirm: writeMemory({region, offset, bytes}) and watch the screen change."
          : "Still multiple — change the value again and memory({op:'searchNext'}) to keep narrowing.",
      });
}

export function registerMemoryTools(server, z, sessionKey) {
  // Shared sub-shapes reused across ops.
  const offsetsShape = z.array(z.union([
    z.number().int().min(0),
    z.object({ offset: z.number().int().min(0), length: z.number().int().min(1).max(65536).default(1) }),
  ])).min(1).max(256);

  server.tool(
    "memory",
    "Read / write / search the core's memory regions, one tool keyed by `op`. " +
    "`region` is the single canonical enum (system_ram, save_ram, video_ram, rtc; NES nes_nametables/nes_palette/nes_oam/nes_chr; " +
    "SNES snes_oam/snes_cgram/snes_aram/snes_fillram; Genesis genesis_cram/vsram/vdp_regs/z80_ram/...). The response carries each region's endianness + wordSize.\n" +
    "OP CHEAT-SHEET (params each op uses): " +
    "read → {region, offset?, length?|offsets?, outputPath?|inline?}; " +
    "write → {region, offset, hex|base64}; " +
    "readCart → {offset?, length?, outputPath?|inline?}; " +
    "snapshot → {region, name, offset?, length?}; " +
    "diff → {region, name, view?}; " +
    "classify → {region?, offset?, length?}; " +
    "search → {value, size?, region?}; " +
    "searchNext → {compare, value?}.\n" +
    `• op:'read' — bytes as a \`hex\` string. ≤${INLINE_HEX_LIMIT}B come back inline; >${INLINE_HEX_LIMIT}B need \`outputPath\` (RAW bytes written → {path,bytes}) or \`inline:true\`. BATCH: \`offsets\` (addresses or {offset,length}) reads many non-contiguous spots in ONE call → reads:[{offset,length,hex}]. (Genesis video_ram is raw host-LE word-swapped — not a direct tile map; use tiles({op:'pixels'}).)\n` +
    "• op:'write' — pass payload as `hex` (e.g. 'deadbeef') OR `base64` — **NOT `data`, `bytes`, or an array (those are REJECTED with guidance).** hex for byte patterns, base64 for binary blobs.\n" +
    "• op:'readCart' — read the LOADED CARTRIDGE ROM image ('is the emulator running my patched bytes?'). For un-banked platforms (Genesis/GB/SMS/Lynx/PCE) the file `offset` IS the CPU ROM address; **NES/SNES skip the header and reach bytes through a mapper, so `mapped:true`+note say the offset is not a flat CPU address.**\n" +
    "• op:'snapshot' — capture a baseline of `region` (server RAM, keyed by `name`) to later diff. The 'which bytes did THIS event touch?' workflow: snapshot → trigger event → op:'diff'.\n" +
    "• op:'diff' — compare a region against a snapshot baseline → the CHANGED bytes. DEFAULT `view:'summary'` is a CLUSTERED summary (+ stride detection — '4 islands at stride 0x80' = a struct array) so a churny gameplay diff doesn't flood context; `view:'raw'` = the per-byte before/after list.\n" +
    "• op:'classify' — heuristically classify the bytes at an offset BEFORE you trust a 'found table'. **Kills the classic trap: a run that 'matches' your stats is often ASCII TEXT (bytes 82/79/68 = 'ROD' from a taunt string) or code.** Returns looksLike/printableRatio/entropy/asciiPreview/confidence.\n" +
    "• op:'search' — seed the iterative RAM value search (Cheat Engine / RetroArch style): all addresses currently holding `value` (`size` 1/2/4 bytes, region's endianness). The primitive for 'the screen shows X, find its RAM address' — better than snapshot+diff for this.\n" +
    "• op:'searchNext' — narrow the active candidate list against CURRENT memory. `compare`: 'eq'/'gt'/'lt' (need `value`), 'changed'/'unchanged'/'inc'/'dec' (vs the previous read). Repeat until 1-2 remain, then confirm with op:'write'.",
    {
      op: z.enum(["read", "write", "readCart", "snapshot", "diff", "classify", "search", "searchNext"])
        .describe("read=bytes→hex; write=hex/base64→region; readCart=loaded cart ROM image; snapshot=capture a baseline; diff=changed bytes vs a baseline; classify=what kind of data is here; search=seed a value search; searchNext=narrow it."),
      region: z.enum(REGIONS).optional().describe("Memory region. Required for read/write/snapshot/diff; defaults to system_ram for classify/search. (readCart targets the cart ROM image, not a region.)"),
      offset: z.number().int().min(0).default(0).describe("Byte offset within the region (read/write/snapshot/classify) or the cart ROM image (readCart)."),
      length: z.number().int().min(1).max(1 << 20).optional().describe("Bytes to read (max 1MB). op:read default 1; op:readCart default 16; op:snapshot default = whole region from offset; op:classify default 256."),
      offsets: offsetsShape.optional().describe("op:read BATCH — a list of addresses (each read `length` bytes, default 1) or {offset,length} objects → reads:[{offset,length,hex}]. Takes precedence over offset/length."),
      // write
      hex: z.string().optional().describe("op:write — hex string, e.g. 'deadbeef' (even length)."),
      base64: z.string().optional().describe("op:write — base64 bytes (binary blobs)."),
      data: z.any().optional().describe("op:write — REJECTED. Pass `hex` (string) or `base64` (string), not an array."),
      bytes: z.any().optional().describe("op:write — REJECTED. Pass `hex` (string) or `base64` (string)."),
      // snapshot/diff/search session label
      name: z.string().default("default").describe("op:snapshot/diff — baseline label (same name to compare). op:search/searchNext — search-session label (narrow the same name; run independent searches with different names)."),
      // diff
      view: z.enum(["summary", "raw"]).default("summary").describe("op:diff — 'summary' (default, clustered ranges + stride) or 'raw' (per-byte before/after)."),
      maxChanges: z.number().int().min(1).max(65536).default(4096).describe("op:diff raw view — cap the per-byte list (changedCount is the true total)."),
      maxClusters: z.number().int().min(1).max(4096).default(64).describe("op:diff summary view — cap the cluster list (clusterCount is the true total)."),
      gap: z.number().int().min(1).max(256).default(4).describe("op:diff summary view — merge changed bytes within this many bytes into one cluster (default 4)."),
      // search / searchNext
      value: z.number().int().optional().describe("op:search — the value the screen shows now. op:searchNext — required for compare 'eq'/'gt'/'lt'."),
      size: z.number().int().min(1).max(4).default(1).describe("op:search — value width in bytes: 1 (stats/lives), 2 (scores/timers), 4 (big counters)."),
      compare: z.enum(["eq", "changed", "unchanged", "inc", "dec", "gt", "lt"]).optional().describe("op:searchNext — eq=now equals `value`; changed/unchanged vs the last read; inc/dec=went up/down; gt/lt=now >/< `value`."),
      maxCandidates: z.number().int().min(1).max(8192).default(64).describe("op:search/searchNext — cap the candidates RETURNED (the full list is kept server-side; `count` is the true total)."),
      // shared output
      outputPath: z.string().optional().describe(`op:read/readCart — write RAW bytes here. Required for reads >${INLINE_HEX_LIMIT}B unless inline. Small reads honor it too (writes file AND returns hex), so 'dump to disk then diff two files' works at any size. (Ignored with offsets.)`),
      inline: z.boolean().default(false).describe(`op:read/readCart — for reads >${INLINE_HEX_LIMIT}B, return the hex in the response instead of writing to disk.`),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "read":       return await memRead(sessionKey, args);
        case "write": {
          if (!args.region) throw new Error("memory({op:'write'}): `region` is required.");
          return await memWrite(sessionKey, args);
        }
        case "readCart":   return await memReadCart(sessionKey, args);
        case "snapshot": {
          if (!args.region) throw new Error("memory({op:'snapshot'}): `region` is required.");
          return await memSnapshot(sessionKey, args);
        }
        case "diff": {
          if (!args.region) throw new Error("memory({op:'diff'}): `region` is required.");
          return await memDiff(sessionKey, args);
        }
        case "classify":   return await memClassify(sessionKey, args);
        case "search": {
          if (args.value == null) throw new Error("memory({op:'search'}): `value` is required.");
          return await memSearch(sessionKey, args);
        }
        case "searchNext": {
          if (!args.compare) throw new Error("memory({op:'searchNext'}): `compare` is required.");
          return await memSearchNext(sessionKey, args);
        }
        default: throw new Error(`memory: unknown op '${args.op}'`);
      }
    }),
  );
}

/** Read a `size`-byte unsigned int from `buf` at `i`, given endianness. */
function readUint(buf, i, size, little) {
  let v = 0;
  if (little) { for (let k = size - 1; k >= 0; k--) v = (v << 8) | buf[i + k]; }
  else { for (let k = 0; k < size; k++) v = (v << 8) | buf[i + k]; }
  return v >>> 0;
}

/** Per-session searchValue candidate lists. Keyed by sessionKey → name → state. */
const _searchSessions = new Map();
function searchSessions(key) { let m = _searchSessions.get(key); if (!m) { m = new Map(); _searchSessions.set(key, m); } return m; }

// Per-session snapshot stores for diffMemory / diffState. Keyed by sessionKey so
// multi-session servers don't cross-contaminate baselines.
/** @type {Map<string, Map<string, {offset:number, bytes:Uint8Array}>>} */
const _memSnaps = new Map();
function memSnapshots(key) { let m = _memSnaps.get(key); if (!m) { m = new Map(); _memSnaps.set(key, m); } return m; }
const snapKey = (region, name) => region + " " + name;

/** Bytes from `offset` to the end of the region — for a whole-region snapshot
 *  when no explicit length is given. Uses the core-reported region size. */
function regionLength(host, region, offset) {
  const size = host.regionSize ? host.regionSize(region) : 0;
  const len = size - offset;
  if (len <= 0) throw new Error(`snapshotMemory: offset ${offset} is past the end of region '${region}' (size ${size}).`);
  return len;
}
