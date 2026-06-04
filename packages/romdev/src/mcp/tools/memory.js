import { getHost } from "../state.js";
import { MemoryRegionToRetro } from "../../host/types.js";
import { jsonContent, safeTool, textContent, writeOutput } from "../util.js";

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
    "Compare a region against an earlier snapshotMemory baseline and return ONLY the bytes that CHANGED: " +
    "`changes:[{offset, before, after}]` (hex), plus `changedCount`. This is the direct answer to 'which bytes " +
    "did this event touch?' — e.g. snapshot system_ram, walk into a door, diffMemory → the handful of state " +
    "bytes the door handler wrote (area id, phase, flags) instead of eyeballing two 2KB hex dumps. Reads the " +
    "SAME offset/length the snapshot covered.",
    {
      region: z.enum(REGIONS),
      name: z.string().default("default").describe("Which snapshotMemory baseline to diff against (same name you snapshotted with)."),
      maxChanges: z.number().int().min(1).max(65536).default(4096).describe("Cap the changes list (default 4096) so a wholesale change doesn't flood the response; `changedCount` is always the true total."),
    },
    safeTool(async ({ region, name, maxChanges }) => {
      const host = getHost(sessionKey);
      const snap = memSnapshots(sessionKey).get(snapKey(region, name));
      if (!snap) throw new Error(`diffMemory: no snapshot named '${name}' for region '${region}'. Call snapshotMemory({region, name}) first.`);
      const now = host.readMemory(region, snap.offset, snap.bytes.length);
      const changes = [];
      let changedCount = 0;
      for (let i = 0; i < snap.bytes.length; i++) {
        if (snap.bytes[i] !== now[i]) {
          changedCount++;
          if (changes.length < maxChanges) {
            changes.push({
              offset: "0x" + (snap.offset + i).toString(16).toUpperCase(),
              offsetDec: snap.offset + i,
              before: snap.bytes[i].toString(16).padStart(2, "0"),
              after: now[i].toString(16).padStart(2, "0"),
            });
          }
        }
      }
      return jsonContent({
        region, name, baseOffset: snap.offset, length: snap.bytes.length,
        changedCount, changes,
        ...(changedCount > changes.length ? { truncated: true, note: `${changedCount} bytes changed; showing first ${changes.length} (raise maxChanges for more).` } : {}),
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
}

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
