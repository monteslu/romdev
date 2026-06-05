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

export function registerMemoryTools(server, z, sessionKey) {
  server.tool(
    "readMemory",
    "Read bytes from one of the core's memory regions, returned as a `hex` string. " +
    `Reads of ≤${INLINE_HEX_LIMIT} bytes always come back inline as hex (the common case — peeking RAM/OAM/palette). ` +
    `For reads >${INLINE_HEX_LIMIT} bytes you MUST pass either outputPath (the RAW bytes are written there and you get ` +
    "back {path, bytes}) or inline:true (the hex comes back in the response). " +
    "Generic regions: system_ram, save_ram, video_ram, rtc. NES extras (fceumm): nes_nametables, nes_palette, nes_oam, nes_chr. " +
    "SNES extras (snes9x): snes_oam (544B incl. hi-table), snes_cgram (512B BGR555), snes_aram (64KB SPC700 RAM), snes_fillram (32KB PPU/DMA register shadow). " +
    "BATCH: pass `offsets` (an array of addresses, or {offset,length} objects) to read several non-contiguous spots in ONE call — returns `reads:[{offset,length,hex}]`. Use this for scattered fields (e.g. player state at $0492, X at $0512, Y at $04F2) instead of one call each.",
    {
      region: z.enum(REGIONS),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(65536).optional().describe("Number of bytes to read (max 65536). Default 1. Ignored when `offsets` is given."),
      offsets: z.array(z.union([
        z.number().int().min(0),
        z.object({ offset: z.number().int().min(0), length: z.number().int().min(1).max(65536).default(1) }),
      ])).min(1).max(256).optional().describe("BATCH read: a list of addresses (each read as `length` bytes, default 1) or {offset,length} objects. Returns `reads:[{offset,length,hex}]` in order — one round-trip for many non-contiguous reads. Takes precedence over the single offset/length."),
      outputPath: z.string().optional().describe(`Absolute path to write the RAW bytes to. Required for reads >${INLINE_HEX_LIMIT} bytes (unless inline:true). For SMALL reads it's honored too when given — writes the file AND returns hex inline — so a "snapshot RAM to disk, then diff two files" flow works at any size. (Not used with \`offsets\`.)`),
      inline: z.boolean().default(false).describe(`For reads >${INLINE_HEX_LIMIT} bytes: if true, return the hex string in the response instead of writing to disk. Default false — then outputPath is required for large reads.`),
    },
    safeTool(async ({ region, offset, length, offsets, outputPath, inline }) => {
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
    }),
  );

  server.tool(
    "writeMemory",
    "Write bytes into one of the core's memory regions. Pass payload as `hex` (e.g. 'deadbeef') OR `base64` — NOT `data`, `bytes`, or an array. Examples: `writeMemory({region:'system_ram', offset:0x200, hex:'42'})` writes one byte; `writeMemory({region:'nes_oam', offset:0, hex:'42'.repeat(256)})` fills shadow OAM with $42. Use `hex` for byte-level patterns (most common), `base64` for binary blobs (sprite tiles, palettes, etc.).",
    {
      region: z.enum(REGIONS),
      offset: z.number().int().min(0).default(0),
      hex: z.string().optional().describe("Hex string, e.g. 'deadbeef' = 4 bytes. Must have even length."),
      base64: z.string().optional().describe("Base64-encoded bytes — use for binary blobs (sprite/palette/tile data) that aren't convenient to write as hex."),
      // Common-mistake catchers: these accept anything, then fail loudly
      // with guidance pointing at hex/base64. Without them, an agent
      // passing data:[1,2,3] hits "hex or base64 required" and may not
      // realize the param name was wrong.
      data: z.any().optional().describe("REJECTED — pass `hex` (string) or `base64` (string) instead. Arrays are not accepted."),
      bytes: z.any().optional().describe("REJECTED — pass `hex` (string) or `base64` (string) instead."),
    },
    safeTool(async ({ region, offset, hex, base64, data, bytes: bytesArg }) => {
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
    }),
  );

  server.tool(
    "readCartRom",
    "Read the LOADED CARTRIDGE ROM (the program image the core is running), as hex. This is the answer to the " +
    "basic patch-confirmation question: 'is the emulator actually running my patched bytes?' — read the offset you " +
    "patched and check the value, instead of inferring it from on-screen behavior. " +
    "For un-banked platforms (Genesis/Mega Drive, GB/GBC, SMS/GG, Lynx, PCE) the file offset IS the CPU ROM " +
    "address — offset N is the byte the CPU fetches at ROM $N, so confirming 'the running ROM has MONTES at " +
    "0x21FF00' is one call. For NES (iNES header is skipped) and SNES (copier header skipped) the BYTES are " +
    "correct but the CPU reaches them through a mapper, so a file offset is not a flat CPU address — the response's " +
    "`mapped:true` + `note` say so. Reads come from the image handed to the core at load (a write to a region does " +
    "NOT change this), so it reflects exactly what was loaded/patched-on-load. " +
    "Reads of ≤" + INLINE_HEX_LIMIT + " bytes return hex inline; larger reads need outputPath (raw bytes written there) or inline:true.",
    {
      offset: z.number().int().min(0).default(0).describe("Byte offset into the cart ROM image (post-header). For un-banked platforms this equals the CPU ROM address."),
      length: z.number().int().min(1).max(1 << 20).default(16).describe("Bytes to read (default 16, max 1MB)."),
      outputPath: z.string().optional().describe(`Absolute path to write RAW bytes to. Required for reads >${INLINE_HEX_LIMIT} bytes unless inline:true.`),
      inline: z.boolean().default(false).describe(`For reads >${INLINE_HEX_LIMIT} bytes: return hex in the response instead of writing to disk.`),
    },
    safeTool(async ({ offset, length, outputPath, inline }) => {
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
    }),
  );

  // ── snapshotMemory / diffMemory — "which bytes changed across this event?" ──
  server.tool(
    "snapshotMemory",
    "Capture a baseline of a memory region (kept in server RAM, keyed by `name`) so you can later diffMemory " +
    "against it. The workflow for 'which bytes did THIS event touch?': snapshotMemory before the event, trigger " +
    "it (pressButton/stepFrames/etc.), then diffMemory after — you get just the changed offsets, no manual " +
    "before/after hex comparison. Snapshots are per-session and overwrite on reuse of the same name.",
    {
      region: z.enum(REGIONS),
      name: z.string().default("default").describe("Snapshot label — diffMemory uses the same name to compare. Take several (e.g. 'before-door', 'before-load') in one session."),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(65536).optional().describe("Bytes to snapshot from offset (default: the whole region from offset)."),
    },
    safeTool(async ({ region, name, offset, length }) => {
      const host = getHost(sessionKey);
      const bytes = host.readMemory(region, offset, length ?? regionLength(host, region, offset));
      memSnapshots(sessionKey).set(snapKey(region, name), { offset, bytes: Uint8Array.from(bytes) });
      return jsonContent({ region, name, offset, length: bytes.length, note: "Baseline captured — trigger your event, then diffMemory({region, name}) for the changed bytes." });
    }),
  );

  server.tool(
    "diffMemory",
    "Compare a region against an earlier snapshotMemory baseline and return the bytes that CHANGED. The direct " +
    "answer to 'which bytes did this event touch?' — snapshot system_ram, walk into a door, diffMemory → the " +
    "state bytes the door handler wrote. " +
    "DEFAULT view is a CLUSTERED SUMMARY (not raw rows) so a gameplay diff that churns thousands of bytes doesn't " +
    "flood your context: `clusters:[{start, end, bytes, stride?}]` groups adjacent changes into ranges, and when " +
    "the ranges are evenly spaced it reports the stride (e.g. '4 islands at stride 0x80' = likely a player-struct " +
    "array — each entity's record). `view:'raw'` returns the per-byte {offset,before,after} list (capped by " +
    "maxChanges) for when you need exact bytes. Reads the SAME offset/length the snapshot covered.",
    {
      region: z.enum(REGIONS),
      name: z.string().default("default").describe("Which snapshotMemory baseline to diff against (same name you snapshotted with)."),
      view: z.enum(["summary", "raw"]).default("summary").describe("'summary' (default) = clustered changed-ranges + stride detection (context-safe). 'raw' = the full per-byte change list."),
      maxChanges: z.number().int().min(1).max(65536).default(4096).describe("raw view only: cap the per-byte list (changedCount is always the true total)."),
      maxClusters: z.number().int().min(1).max(4096).default(64).describe("summary view: cap the cluster list (clusterCount is the true total)."),
      gap: z.number().int().min(1).max(256).default(4).describe("summary view: merge changed bytes into one cluster if they're within this many bytes of each other (default 4)."),
    },
    safeTool(async ({ region, name, view, maxChanges, maxClusters, gap }) => {
      const host = getHost(sessionKey);
      const snap = memSnapshots(sessionKey).get(snapKey(region, name));
      if (!snap) throw new Error(`diffMemory: no snapshot named '${name}' for region '${region}'. Call snapshotMemory({region, name}) first.`);
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
            "Use view:'raw' for exact before/after bytes (or narrow with a tighter event window). For 'find the address of value X' use searchValue, not diff.",
      });
    }),
  );

  server.tool(
    "diffState",
    "Like diffMemory but for the WHOLE machine: snapshot the serialized save-state, and diff returns whether it " +
    "changed + a byte-delta count. Coarser than diffMemory (the state blob is core-internal, not a clean memory " +
    "map) — use diffMemory for 'which RAM bytes' and diffState for a quick 'did anything at all change across " +
    "this?' Pass mode:'snapshot' to capture, mode:'diff' to compare.",
    {
      name: z.string().default("default").describe("State snapshot label."),
      mode: z.enum(["snapshot", "diff"]).describe("'snapshot' captures the current state as the baseline; 'diff' compares the current state to it."),
    },
    safeTool(async ({ name, mode }) => {
      const host = getHost(sessionKey);
      const store = stateSnapshots(sessionKey);
      if (mode === "snapshot") {
        const blob = host.serializeState();
        store.set(name, Uint8Array.from(blob));
        return jsonContent({ name, mode, size: blob.length, note: "State baseline captured — trigger your event, then diffState({name, mode:'diff'})." });
      }
      const base = store.get(name);
      if (!base) throw new Error(`diffState: no state snapshot named '${name}'. Call diffState({name, mode:'snapshot'}) first.`);
      const now = host.serializeState();
      let differingBytes = 0;
      const len = Math.min(base.length, now.length);
      for (let i = 0; i < len; i++) if (base[i] !== now[i]) differingBytes++;
      const sizeChanged = base.length !== now.length;
      return jsonContent({
        name, mode,
        changed: differingBytes > 0 || sizeChanged,
        differingBytes,
        sizeChanged,
        baselineSize: base.length,
        currentSize: now.length,
        note: "State blobs are core-internal — for the actual changed RAM addresses use snapshotMemory/diffMemory.",
      });
    }),
  );

  // ── classifyRegion — "what kind of data is at this offset?" ──────────────
  server.tool(
    "classifyRegion",
    "Heuristically classify the bytes at an offset — BEFORE you trust a 'found table'. Kills the classic RE " +
    "trap: a run of values that 'matches' the stats you want is often ASCII TEXT (e.g. bytes 82/79/68 = 'R'/'O'/" +
    "'D' from a taunt string, not a stat table) or code. Returns `{looksLike: 'ascii-text'|'high-entropy'|" +
    "'sparse-or-tiledata'|'structured-data'|'unknown', printableRatio, entropy, zeroRatio, longestAsciiRun, " +
    "asciiPreview, confidence, note}`. If `looksLike` is 'ascii-text', a 'data table' overlapping this offset is " +
    "almost certainly a coincidence — do NOT patch it as a table. Use on any region (system_ram, video_ram, or " +
    "the cart ROM region) at any offset. Cheap; run it whenever a candidate offset 'looks right' to confirm it's " +
    "actually the kind of data you think.",
    {
      region: z.enum(REGIONS).default("system_ram"),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(4).max(65536).default(256).describe("Bytes to classify from offset (default 256). Use the suspected table's length."),
    },
    safeTool(async ({ region, offset, length }) => {
      const host = getHost(sessionKey);
      const bytes = host.readMemory(region, offset, length);
      const cls = classifyBytes(bytes, { bigEndian: genericEndianness(host.status.platform) === "big" });
      return jsonContent({ region, offset: "0x" + offset.toString(16), length: bytes.length, ...cls });
    }),
  );

  // ── searchValue / searchNext — the iterative RAM value search (Cheat Engine /
  //    RetroArch cheat-search workflow). THE primitive for "the screen shows X;
  //    find its RAM address." Seed with searchValue, then narrow each time the
  //    value changes with op:'eq'|'changed'|'unchanged'|'gt'|'lt'|'inc'|'dec'.
  //    The candidate list lives per session (keyed by `name`); each narrow reads
  //    the region fresh and keeps only candidates that still satisfy the op.
  server.tool(
    "searchValue",
    "Find the RAM address(es) holding a value — the iterative 'cheat search' every RE workflow needs (find the " +
    "score / timer / health / record-id / stat). Seeds a candidate list, then you NARROW it with searchNext as " +
    "the value changes in-game, exactly like Cheat Engine / RetroArch. Far better than snapshotMemory+diffMemory " +
    "for this (which floods you with every byte gameplay churns). " +
    "WORKFLOW: (1) `searchValue({value: 7, size: 1})` while the screen shows 7 → all addresses currently holding " +
    "7. (2) make the value change in-game (lose a life → 6), then `searchNext({op:'eq', value: 6})` → only " +
    "addresses that are NOW 6 AND were a candidate. Repeat until 1-2 remain. (3) confirm with writeMemory + watch " +
    "the screen. " +
    "If you don't know the new value, use op-only narrows: `searchNext({op:'dec'})` (value went down), " +
    "`'inc'`, `'changed'`, `'unchanged'`. `size` is 1/2/4 bytes (uses the region's endianness). Works on EVERY " +
    "platform — defaults to `system_ram` (the CPU's work RAM). Returns `{candidates, count, searchId, sample}`.",
    {
      value: z.number().int().describe("The value the screen currently shows (e.g. the score, a stat, lives). Interpreted as a `size`-byte unsigned int in the region's byte order."),
      size: z.number().int().min(1).max(4).default(1).describe("Value width in bytes: 1 (most stats/lives/health), 2 (scores/timers), 4 (big counters)."),
      region: z.enum(REGIONS).default("system_ram").describe("Where to search. Default system_ram (the CPU work RAM where game state lives). Use save_ram, snes_aram, etc. for special cases."),
      name: z.string().default("default").describe("Search session label — searchNext narrows the same name. Run independent searches in parallel with different names."),
      maxCandidates: z.number().int().min(1).max(8192).default(64).describe("Cap the candidate addresses RETURNED (the full list is kept server-side for narrowing); `count` is the true total."),
    },
    safeTool(async ({ value, size, region, name, maxCandidates }) => {
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
          ? "1 candidate — likely THE address. Confirm with writeMemory({region, offset, bytes}) and watch the screen."
          : "Make the value change in-game, then searchNext({name, op:'eq', value:<new>}) to narrow. Repeat until 1-2 remain.",
      });
    }),
  );

  server.tool(
    "searchNext",
    "Narrow an active searchValue candidate list against the CURRENT memory. Call after the value changed in " +
    "game. `op`: 'eq' (candidates now equal to `value`), 'changed'/'unchanged' (vs the previous search read), " +
    "'inc'/'dec' (went up/down), 'gt'/'lt' (now greater/less than `value`). 'eq'/'gt'/'lt' need `value`; the " +
    "others don't (they compare to the previous snapshot). Returns the narrowed `{candidates, count}` — repeat " +
    "until 1-2 remain, then confirm with writeMemory. This is the loop that turns 'somewhere in 8KB of RAM' into " +
    "an exact address in a few steps.",
    {
      op: z.enum(["eq", "changed", "unchanged", "inc", "dec", "gt", "lt"]).describe("How to narrow: eq=now equals `value`; changed/unchanged vs the last read; inc/dec=went up/down; gt/lt=now >/< `value`."),
      value: z.number().int().optional().describe("Required for op 'eq'/'gt'/'lt' — the value now shown on screen."),
      name: z.string().default("default").describe("Which searchValue session to narrow (the `name` you seeded with)."),
      maxCandidates: z.number().int().min(1).max(8192).default(64),
    },
    safeTool(async ({ op, value, name, maxCandidates }) => {
      const host = getHost(sessionKey);
      const s = searchSessions(sessionKey).get(name);
      if (!s) throw new Error(`searchNext: no active search named '${name}'. Call searchValue({value, name}) first.`);
      if ((op === "eq" || op === "gt" || op === "lt") && value === undefined) {
        throw new Error(`searchNext: op '${op}' needs a \`value\` (the number now on screen).`);
      }
      const buf = host.readMemory(s.region, 0, regionLength(host, s.region, 0));
      const read = (i) => readUint(buf, i, s.size, s.little);
      const v = (value ?? 0) >>> 0;
      const kept = [];
      for (const a of s.addrs) {
        const cur = read(a);
        const prev = s.prev ? s.prev.get(a) : undefined;
        let ok = false;
        switch (op) {
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
      // Remember this read so the next op:'changed'/'inc'/'dec' has a baseline.
      const prevMap = new Map();
      for (const a of kept) prevMap.set(a, read(a));
      s.addrs = Uint32Array.from(kept);
      s.prev = prevMap;
      searchSessions(sessionKey).set(name, s);
      return jsonContent({
        searchId: name, op, count: kept.length,
        candidates: kept.slice(0, maxCandidates).map((a) => "0x" + a.toString(16) + "=" + read(a)),
        note: kept.length === 0
          ? "0 left — narrowed too far (wrong op, or the value moved between reads). Re-seed with searchValue."
          : kept.length <= 2
          ? "Down to 1-2 — confirm: writeMemory({region, offset, bytes}) and watch the screen change."
          : "Still multiple — change the value again and searchNext to keep narrowing.",
      });
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
/** @type {Map<string, Map<string, Uint8Array>>} */
const _stateSnaps = new Map();
function memSnapshots(key) { let m = _memSnaps.get(key); if (!m) { m = new Map(); _memSnaps.set(key, m); } return m; }
function stateSnapshots(key) { let m = _stateSnaps.get(key); if (!m) { m = new Map(); _stateSnaps.set(key, m); } return m; }
const snapKey = (region, name) => region + " " + name;

/** Bytes from `offset` to the end of the region — for a whole-region snapshot
 *  when no explicit length is given. Uses the core-reported region size. */
function regionLength(host, region, offset) {
  const size = host.regionSize ? host.regionSize(region) : 0;
  const len = size - offset;
  if (len <= 0) throw new Error(`snapshotMemory: offset ${offset} is past the end of region '${region}' (size ${size}).`);
  return len;
}
