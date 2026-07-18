import { getHost } from "../state.js";
import { MemoryRegionToRetro } from "romdev-core-host/types.js";
import { jsonContent, safeTool, textContent, writeOutput } from "../util.js";
import { classifyBytes } from "./classify-region.js";
import { clusterChanges } from "./diff-cluster.js";
import { mapNesAddress, mapSnesAddress } from "./disasm.js";

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

async function memRead(sessionKey, { region, offset = 0, length, offsets, outputPath, inline, echo, compact }) {
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
        // compact:true — the "sample N flags" shape: one {"0xOFF":"hex"} map
        // instead of an object per read (~4x fewer tokens on a dozen 1-2 byte
        // probes; v0.94.0 feedback). Region/endianness still echoed once.
        if (compact) {
          const map = {};
          for (const r of reads) map["0x" + r.offset.toString(16)] = r.hex;
          return jsonContent({ region, endianness: endianness0, reads: map });
        }
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
      const info = REGION_INFO[region] ?? {};   /* (restored — a careless replace-all removed it) */
      const endianness = info.endianness ?? genericEndianness(host.status.platform);
      // Genesis VRAM is stored by genesis-plus-gx as 16-bit words in HOST
      // (little-endian) byte order, so these raw bytes have each word's two
      // bytes swapped vs the VDP-logical layout — a raw read is NOT a direct
      // tile/pixel map. (The VDP un-swaps when rendering, so the screen is
      // correct.) Use getTile (logicalPixels:true, the default) to decode tiles
      // in render order instead of un-swapping by hand.
      let note = info.note ?? null;
      if (region === "system_ram" && host.status.platform === "genesis") {
        note = (note ? note + " " : "") +
          "GENESIS: normalized to CPU byte order — offset X IS the byte the 68k sees at $FF0000+X " +
          "(the host un-swaps gpgx's word-swapped storage), so offsets line up with disassembly " +
          "addresses and cheat-DB maps. Words are big-endian, as the meta says.";
      }
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
        // Only emit `note` when there's actually one — a region with no note
        // (system_ram, most work-RAM) used to return `note: null` every read
        // (field report: pure noise on a batch RE loop).
        ...(note ? { note } : {}),
      };
      // Large reads: path-or-inline. Write the RAW bytes to disk (not hex) so
      // the artifact is directly usable; inline returns the hex string.
      if (bytes.length > INLINE_HEX_LIMIT && !inline) {
        const { path, bytes: written } = writeOutput(bytes, { outputPath, what: `readMemory(${region})` });
        return jsonContent({ ...meta, path, bytes: written });
      }
      // Small read WITH an explicit outputPath: honor it — write the raw bytes
      // to disk AND (by default) still return the hex inline. Pass echo:false
      // to get just {path, bytes}: a 2KB RAM dump's ~4KB hex echo was the
      // largest avoidable token cost in a real RE session (0.27.0 feedback #4)
      // when the whole point of outputPath was keeping it out of context.
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      if (outputPath) {
        const { path, bytes: written } = writeOutput(bytes, { outputPath, what: `readMemory(${region})` });
        if (echo === false) return jsonContent({ ...meta, path, bytes: written });
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

async function memReadCart(sessionKey, { offset = 0, length = 16, cpuAddress, bank, mapper, outputPath, inline, echo, findHex, maxMatches = 100 }) {
      const host = getHost(sessionKey);
      const rom = host.getCartRom();

      // findHex (v0.94.0 round 2): byte-pattern scan over the LOADED cart image —
      // the call-site hunt ("who jsr's $873C?" = scan for `20 3C 87`) that agents
      // otherwise script in Python over the ROM file. Each match returns the file
      // offset AND the mapped CPU address (the offset→bank:addr arithmetic is
      // exactly the part hand-conversion gets wrong). Same hex-string contract as
      // state({op:'dump', findHex}).
      if (findHex != null) {
        const cleaned = String(findHex).replace(/[\s_$]/g, "");
        if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
          throw new Error(`memory({op:'readCart', findHex}): must be an even-length hex string, got '${findHex}'`);
        }
        const needle = Buffer.from(cleaned, "hex");
        const hay = Buffer.from(rom.bytes.buffer, rom.bytes.byteOffset, rom.bytes.byteLength);
        // Per-platform inverse map: file offset (header-stripped image) → CPU address.
        let toCpu = null;
        if (rom.platform === "nes") {
          const prgSize = hay.length; // rom.bytes IS the PRG image for NES
          const lastBank = Math.floor((prgSize - 1) / 0x4000);
          toCpu = (o) => {
            const b = Math.floor(o / 0x4000);
            const addr = (b === lastBank ? 0xC000 : 0x8000) + (o & 0x3FFF);
            return { cpuAddress: "$" + addr.toString(16).toUpperCase(), bank: b };
          };
        } else if (rom.platform === "snes") {
          // Self-consistent lo/hi detection: ask the forward mapper where
          // $00:8000 (LoROM probe) lands. LoROM → file 0.
          let isLo = true;
          try { isLo = mapSnesAddress(rom.raw, 0x008000, 1, mapper).fileOffset - (rom.raw.length - hay.length) === 0; }
          catch { /* default lorom */ }
          toCpu = (o) => isLo
            ? { cpuAddress: "$" + (o >> 15).toString(16).toUpperCase().padStart(2, "0") + ":" + (0x8000 | (o & 0x7FFF)).toString(16).toUpperCase().padStart(4, "0") }
            : { cpuAddress: "$" + (0xC0 + (o >> 16)).toString(16).toUpperCase().padStart(2, "0") + ":" + (o & 0xFFFF).toString(16).toUpperCase().padStart(4, "0") };
        } else if (rom.platform === "gb" || rom.platform === "gbc") {
          // MBC convention: bank 0 fixed at $0000-$3FFF; every other bank
          // through the $4000-$7FFF window.
          toCpu = (o) => {
            const b = Math.floor(o / 0x4000);
            const addr = b === 0 ? o : 0x4000 + (o & 0x3FFF);
            return { cpuAddress: "$" + addr.toString(16).toUpperCase(), bank: b };
          };
        } else if (rom.platform === "sms" || rom.platform === "gg") {
          // Sega mapper convention: slot0 $0000/slot1 $4000 fixed-ish, banks ≥2
          // usually paged through slot 2 at $8000.
          toCpu = (o) => {
            const b = Math.floor(o / 0x4000);
            const addr = (b <= 1 ? b * 0x4000 : 0x8000) + (o & 0x3FFF);
            return { cpuAddress: "$" + addr.toString(16).toUpperCase(), bank: b };
          };
        } else if (rom.base) {
          toCpu = (o) => ({ cpuAddress: "0x" + (rom.base + o).toString(16).toUpperCase() });
        }
        const matches = [];
        let from = 0;
        while (matches.length < maxMatches) {
          const i = hay.indexOf(needle, from);
          if (i < 0) break;
          matches.push({ fileOffset: "0x" + i.toString(16).toUpperCase(), ...(toCpu ? toCpu(i) : {}) });
          from = i + 1;
        }
        return jsonContent({
          platform: rom.platform,
          findHex: cleaned,
          count: matches.length,
          truncated: matches.length === maxMatches,
          matches,
          note: (rom.platform === "nes"
            ? "cpuAddress assumes the standard $8000-window convention (last PRG bank fixed at $C000); on an exotic mapper trust bank+the $3FFF offset over the literal address. "
            : rom.platform === "snes" ? "cpuAddress is bank:addr in the cart's detected mapping (LoROM/HiROM from the header). "
            : rom.platform === "gb" || rom.platform === "gbc" ? "cpuAddress uses the MBC convention (bank 0 at $0000, banks ≥1 through the $4000 window) — trust bank+offset on an exotic mapper. "
            : rom.platform === "sms" || rom.platform === "gg" ? "cpuAddress uses the Sega-mapper convention (banks ≥2 through slot 2 at $8000) — trust bank+offset if the game repages slots. "
            : "") +
            "Scan is over the header-stripped cart image (fileOffset is image-relative" + ((rom.raw?.length ?? 0) > (rom.bytes?.length ?? 0) ? `; add ${(rom.raw.length - rom.bytes.length)} for the raw file` : "") + ").",
        });
      }

      // Banked CPU-address read (0.28.0 feedback #2a): map {cpuAddress, bank?} →
      // PRG bytes, the inverse of the breakpoint result's bank/prgOffset. Saves
      // the caller the hand-computed `cpuAddr - 0x8000 + bank*0x4000` arithmetic
      // that bit them twice. NES + SNES today (reuses the disasm mappers).
      if (cpuAddress != null) {
        let m;
        if (rom.platform === "nes") {
          m = mapNesAddress(rom.raw, cpuAddress >>> 0, length, bank);
        } else if (rom.platform === "snes") {
          // SNES: the bank IS the address's high byte. `mapSnesAddress` ignores a
          // separate `bank` param — field report: a bank-local addr + bank:2 read
          // BANK 0 silently. Compose it into the 24-bit address, same fix as
          // disasm({target:'rom', bank}).
          let addr = cpuAddress >>> 0;
          if (bank != null && addr < 0x10000) addr = ((bank & 0xFF) << 16) | addr;
          m = mapSnesAddress(rom.raw, addr, length, mapper);
        } else {
          throw new Error(`memory({op:'readCart', cpuAddress}): banked CPU-address mapping is NES/SNES only (got '${rom.platform}'). Use a flat 'offset' for this platform.`);
        }
        const hex = Array.from(m.bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        const meta = {
          platform: rom.platform,
          cpuAddress: "0x" + (cpuAddress >>> 0).toString(16).toUpperCase(),
          ...(bank != null ? { bank } : {}),
          fileOffset: "0x" + m.fileOffset.toString(16).toUpperCase(),
          prgOffset: "0x" + (m.fileOffset - (m.prgFileStart ?? 0)).toString(16).toUpperCase(),
          length: m.bytes.length,
          note: m.note,
        };
        if (outputPath) {
          const { path, bytes: written } = writeOutput(Uint8Array.from(m.bytes), { outputPath, what: "readCartRom" });
          if (echo === false) return jsonContent({ ...meta, path, bytes: written });
          return jsonContent({ ...meta, path, bytes: written, hex });
        }
        return jsonContent({ ...meta, hex });
      }

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
        if (echo === false) return jsonContent({ ...meta, path, bytes: written });
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

// ── diffRuns — A/B scenario diff: THE input→RAM mapping primitive ─────────
// Runs the SAME starting state twice (savestate restore in between) under two
// different held inputs, then diffs the two post-run memories. Replaces the
// hand-rolled save → hold A → step → dump → restore → hold B → step → dump →
// client-side python diff loop (~6 calls + a 4KB context hit) with ONE call
// (0.27.0 feedback #6). The emulator is left at the END OF RUN B.
async function memDiffRuns(sessionKey, { region, frames = 60, portsA, portsB, offset = 0, length, minDelta, maxClusters = 64, gap = 4 }) {
      const host = getHost(sessionKey);
      const baseline = host.serializeState();
      let bufA, bufB;
      try {
        host.setInput({ ports: portsA ?? [{}] });
        host.stepFrames(frames);
        bufA = host.readMemory(region, offset, length ?? regionLength(host, region, offset));
      } finally {
        host.unserializeState(baseline);
      }
      host.setInput({ ports: portsB ?? [{}] });
      host.stepFrames(frames);
      bufB = host.readMemory(region, offset, bufA.length);
      host.setInput({ ports: [{}] });

      const divergent = [];
      for (let i = 0; i < Math.min(bufA.length, bufB.length); i++) {
        if (bufA[i] === bufB[i]) continue;
        if (minDelta != null && Math.abs(bufB[i] - bufA[i]) < minDelta) continue;
        divergent.push(offset + i);
      }
      const { clusters, stride } = clusterChanges(divergent, { gap });
      const out = clusters.slice(0, maxClusters).map((c) => {
        const entry = {
          start: "0x" + c.startDec.toString(16).toUpperCase(),
          end: "0x" + c.endDec.toString(16).toUpperCase(),
          span: c.endDec - c.startDec + 1,
          bytes: c.bytes,
        };
        if (c.endDec - c.startDec + 1 <= 8) {
          let a = "", b = "";
          for (let addr = c.startDec; addr <= c.endDec; addr++) {
            a += bufA[addr - offset].toString(16).padStart(2, "0");
            b += bufB[addr - offset].toString(16).padStart(2, "0");
          }
          entry.runA = a;
          entry.runB = b;
        }
        return entry;
      });
      return jsonContent({
        region, frames, offset, length: bufA.length,
        portsA: portsA ?? [{}], portsB: portsB ?? [{}],
        divergentCount: divergent.length,
        clusterCount: clusters.length,
        clusters: out,
        ...(stride !== null ? { stride: "0x" + stride.toString(16) } : {}),
        ...(clusters.length > out.length ? { truncated: true } : {}),
        note: divergent.length === 0
          ? "No divergent bytes — the two inputs produced identical memory after " + frames + " frames. Try more frames, or inputs the game actually distinguishes in this state."
          : "Each cluster diverges between the two runs; runA/runB are the post-run bytes (small clusters only). The byte that tracks your input is usually the small cluster whose runA-vs-runB delta matches the expected movement. Emulator is left at the END OF RUN B.",
      });
}

async function memDiff(sessionKey, { region, name = "default", view = "summary", maxChanges = 4096, maxClusters = 64, gap = 4, minDelta, changeDir, beforeMin, beforeMax, afterMin, afterMax, deltaEq, outputPath, echo = true }) {
      const host = getHost(sessionKey);
      const snap = memSnapshots(sessionKey).get(snapKey(region, name));
      if (!snap) throw new Error(`memory({op:'diff'}): no snapshot named '${name}' for region '${region}'. Call memory({op:'snapshot', region, name}) first.`);
      const now = host.readMemory(region, snap.offset, snap.bytes.length);

      // Collect changed offsets once, applying server-side predicate filters so
      // the lives/score/ammo hunt is ONE call instead of dumping the whole diff
      // and filtering client-side (0.28.0 feedback #3). All filters AND together:
      //   minDelta   — |after-before| >= minDelta (drop small wiggles; 0.27.0 #5)
      //   changeDir  — 'dec' (after<before) | 'inc' (after>before)
      //   deltaEq    — after-before === deltaEq EXACTLY (signed; e.g. -1 for "lost one life")
      //   beforeMin/Max, afterMin/Max — value-range gates on the old/new byte
      // Example: a 537-byte death diff → the ~3 "decreased by exactly 1 from a
      // small value" rows with {changeDir:'dec', beforeMax:9, deltaEq:-1}.
      const changedOffsets = [];
      for (let i = 0; i < snap.bytes.length; i++) {
        const b = snap.bytes[i], a = now[i];
        if (b === a) continue;
        if (minDelta != null && Math.abs(a - b) < minDelta) continue;
        if (changeDir === "dec" && !(a < b)) continue;
        if (changeDir === "inc" && !(a > b)) continue;
        if (deltaEq != null && (a - b) !== deltaEq) continue;
        if (beforeMin != null && b < beforeMin) continue;
        if (beforeMax != null && b > beforeMax) continue;
        if (afterMin != null && a < afterMin) continue;
        if (afterMax != null && a > afterMax) continue;
        changedOffsets.push(i);
      }
      const changedCount = changedOffsets.length;
      const filtered = (changeDir != null || deltaEq != null || beforeMin != null ||
        beforeMax != null || afterMin != null || afterMax != null);

      if (view === "raw") {
        const changes = changedOffsets.slice(0, maxChanges).map((i) => ({
          offset: "0x" + (snap.offset + i).toString(16).toUpperCase(),
          offsetDec: snap.offset + i,
          before: snap.bytes[i].toString(16).padStart(2, "0"),
          after: now[i].toString(16).padStart(2, "0"),
        }));
        const result = {
          region, name, view, baseOffset: snap.offset, length: snap.bytes.length,
          ...(filtered ? { filterMatches: changedCount } : { changedCount }),
          changes,
          ...(changedCount > changes.length ? { truncated: true, note: `${changedCount} ${filtered ? "matching " : ""}bytes changed; showing first ${changes.length} (raise maxChanges).` } : {}),
        };
        return diffOut(result, { outputPath, echo, region, heavyKey: "changes", count: changedCount });
      }

      // SUMMARY: cluster adjacent changes (within `gap`) into ranges + stride.
      const { clusters, stride } = clusterChanges(changedOffsets.map((i) => snap.offset + i), { gap });
      const strideNote = stride !== null
        ? `${clusters.length} change-islands evenly spaced at stride 0x${stride.toString(16)} — likely a struct/entity ARRAY (each island = one record's changed fields).`
        : null;
      // Per-cluster before/after for SMALL clusters (≤8 bytes): the summary
      // view used to give only ranges, forcing a fall back to view:'raw' to
      // see the values (0.27.0 feedback #5). Large clusters stay range-only.
      const out = clusters.slice(0, maxClusters).map((c) => {
        const entry = {
          start: "0x" + c.startDec.toString(16).toUpperCase(),
          end: "0x" + c.endDec.toString(16).toUpperCase(),
          span: c.endDec - c.startDec + 1,
          bytes: c.bytes,
        };
        const span = c.endDec - c.startDec + 1;
        if (span <= 8) {
          let before = "", after = "";
          for (let a = c.startDec; a <= c.endDec; a++) {
            const i = a - snap.offset;
            before += snap.bytes[i].toString(16).padStart(2, "0");
            after += now[i].toString(16).padStart(2, "0");
          }
          entry.before = before;
          entry.after = after;
        }
        return entry;
      });
      const result = {
        region, name, view, baseOffset: snap.offset, length: snap.bytes.length,
        ...(filtered ? { filterMatches: changedCount } : { changedCount }), clusterCount: clusters.length,
        clusters: out,
        ...(stride !== null ? { stride: "0x" + stride.toString(16), strideHint: strideNote } : {}),
        ...(clusters.length > out.length ? { truncated: true } : {}),
        note: changedCount === 0
          ? (filtered ? "No changed byte matched the filters (try loosening changeDir/deltaEq/before*/after*)." : "Nothing changed.")
          : `${changedCount} ${filtered ? "matching " : ""}bytes changed in ${clusters.length} cluster(s). ` +
            (stride !== null ? strideNote + " " : "") +
            "Use view:'raw' for exact before/after bytes (or narrow with a tighter event window / the changeDir/deltaEq/before*/after* filters). For 'find the address of value X' use memory({op:'search'}), not diff.",
      };
      return diffOut(result, { outputPath, echo, region, heavyKey: "clusters", count: changedCount });
}

// Honor outputPath/echo for diff results, mirroring memRead (0.28.0 feedback
// #2): write the FULL JSON to outputPath regardless of size; with echo:false
// return only the slim envelope (counts + path), dropping the heavy array so a
// large diff never streams through context.
function diffOut(result, { outputPath, echo, region, heavyKey, count }) {
  if (!outputPath) return jsonContent(result);
  const { path, bytes } = writeOutput(JSON.stringify(result, null, 2), { outputPath, what: `diff(${region})` });
  if (echo === false) {
    const { [heavyKey]: _omit, ...slim } = result;
    return jsonContent({ ...slim, path, bytes, echo: false, note: `Full diff written to ${path} (${count} changes); '${heavyKey}' omitted (echo:false).` });
  }
  return jsonContent({ ...result, path, bytes });
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
/**
 * Decode one candidate value at `i` under the search's representation.
 *   raw    — `size`-byte unsigned int, region endianness.
 *   bcd    — `size` bytes of packed BCD (2 decimal digits per byte, region
 *            endianness): bytes [0x25,0x01] (LE) = 125. Returns null when any
 *            nibble is >9 (not a BCD value).
 *   digits — `digitLen` consecutive bytes, one DECIMAL DIGIT per byte, most
 *            significant first (HUD order), each offset by the candidate's
 *            constant tile base `k` (0 for raw digits, 0x30 for ASCII, or the
 *            game's digit-tile index). Returns null when any byte fails to
 *            decode as k+0..9.
 * @returns {number|null}
 */
function decodeAt(buf, i, s, k = 0) {
  if (s.as === "digits") {
    if (i + s.digitLen > buf.length) return null;
    let v = 0;
    for (let j = 0; j < s.digitLen; j++) {
      const d = buf[i + j] - k;
      if (d < 0 || d > 9) return null;
      v = v * 10 + d;
    }
    return v;
  }
  if (i + s.size > buf.length) return null;
  const u = readUint(buf, i, s.size, s.little);
  if (s.as === "bcd") {
    const hex = u.toString(16);
    if (!/^[0-9]+$/.test(hex)) return null;   // a nibble >9 → not BCD
    return parseInt(hex, 10);
  }
  return u;
}

async function memSearch(sessionKey, { value, size = 1, as = "raw", region = "system_ram", name = "default", maxCandidates = 64 }) {
      const host = getHost(sessionKey);
      const info = REGION_INFO[region] ?? {};
      const little = (info.endianness ?? genericEndianness(host.status.platform)) !== "big";
      const buf = host.readMemory(region, 0, regionLength(host, region, 0));
      const digitStr = String(value >>> 0);
      const s = { region, size, little, as, digitLen: digitStr.length };
      const candidates = [];
      /** digits mode: per-candidate constant tile-base offset (addr → k). */
      const kMap = as === "digits" ? new Map() : null;
      if (as === "digits") {
        // One byte per decimal digit, MSD first, all offset by a constant k
        // (HUD digits are usually tile indices: k=0 raw, k=0x30 ASCII, or the
        // font's digit base). k is derived per candidate from the first digit.
        // Single-digit values would match EVERY byte with a free k, so they
        // only accept the common bases.
        const digits = Array.from(digitStr, (c) => c.charCodeAt(0) - 0x30);
        const SINGLE_DIGIT_BASES = [0x00, 0x30];
        for (let i = 0; i + digits.length <= buf.length; i++) {
          const k = buf[i] - digits[0];
          if (k < 0 || k > 255 - 9) continue;
          if (digits.length === 1 && !SINGLE_DIGIT_BASES.includes(k)) continue;
          let ok = true;
          for (let j = 1; j < digits.length; j++) {
            if (buf[i + j] !== digits[j] + k) { ok = false; break; }
          }
          if (ok) { candidates.push(i); kMap.set(i, k); }
        }
      } else {
        for (let i = 0; i + size <= buf.length; i++) {
          if (decodeAt(buf, i, s) === (value >>> 0)) candidates.push(i);
        }
      }
      // Baseline EVERY candidate at seed time so relative compares
      // ('inc'/'dec'/'changed'/'unchanged') work as the FIRST narrow. Pre-fix,
      // the baseline only existed after a value-based round — the first
      // relative searchNext silently returned 0 candidates (a real session
      // burned rounds on this; it was documented as a footgun instead of fixed).
      const prevMap = new Map();
      for (const a of candidates) prevMap.set(a, value >>> 0);
      searchSessions(sessionKey).set(name, { ...s, addrs: Uint32Array.from(candidates), prev: prevMap, kMap });
      return jsonContent({
        searchId: name, region, size, as,
        count: candidates.length,
        candidates: candidates.slice(0, maxCandidates).map((a) =>
          "0x" + a.toString(16) + (kMap && kMap.get(a) ? ` (digitBase 0x${kMap.get(a).toString(16)})` : "")),
        note: candidates.length === 0
          ? "0 matches — wrong size? (try size:2 for a score). Stored ≠ displayed is common: lives are often displayed−1 (re-seed with value-1), scores ÷10. Try as:'bcd' (packed BCD) or as:'digits' (one byte per on-screen digit, any constant tile base) — or a different region."
          : candidates.length === 1
          ? "1 candidate — likely THE address. Confirm with memory({op:'write', region, offset, hex}) and watch the screen."
          : "Change the value in-game, then memory({op:'searchNext', name, compare:'eq', value:<new>}) to narrow — or compare:'inc'/'dec'/'changed' right away (baselines are recorded at seed). Repeat until 1-2 remain.",
      });
}

// op:'searchUnknown' — the Cheat-Engine UNKNOWN-INITIAL-VALUE hunt: seed the
// candidate set to the WHOLE region (every size-aligned offset, baselined to
// its current value), with NO value filter. Then narrow across in-game events
// with searchNext compare:'dec'/'inc'/'unchanged'/'changed'/'gt'/'lt'. This is
// the canonical "find the lives/score/timer address you can't see" loop, which
// op:'search' (requires a value) can't do. (0.28.0 feedback #1.)
async function memSearchUnknown(sessionKey, { size = 1, as = "raw", region = "system_ram", name = "default", maxCandidates: _maxCandidates = 64 }) {
      const host = getHost(sessionKey);
      if (as === "digits") throw new Error("memory({op:'searchUnknown'}): as:'digits' needs a value; use as:'raw' or 'bcd' for an unknown-value hunt.");
      const info = REGION_INFO[region] ?? {};
      const little = (info.endianness ?? genericEndianness(host.status.platform)) !== "big";
      const buf = host.readMemory(region, 0, regionLength(host, region, 0));
      const s = { region, size, little, as, digitLen: 0 };
      // Seed EVERY size-aligned offset; baseline each to its current decoded
      // value so the first searchNext relative compare works immediately.
      const candidates = [];
      const prevMap = new Map();
      for (let i = 0; i + size <= buf.length; i += size) {
        const cur = decodeAt(buf, i, s);
        if (cur === null) continue;
        candidates.push(i);
        prevMap.set(i, cur);
      }
      searchSessions(sessionKey).set(name, { ...s, addrs: Uint32Array.from(candidates), prev: prevMap, kMap: null });
      return jsonContent({
        searchId: name, region, size, as, mode: "unknown",
        count: candidates.length,
        note: `Seeded ${candidates.length} candidates (the whole region, no value filter). Now cause the value to change in-game, then narrow with memory({op:'searchNext', name:'${name}', compare:'dec'|'inc'|'unchanged'|'changed'|'gt'|'lt'}) — e.g. 'dec' after losing a life, 'unchanged' across a frame where it shouldn't move. Repeat until 1-2 remain, then confirm with op:'write'.`,
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
      const read = (a) => decodeAt(buf, a, s, s.kMap ? s.kMap.get(a) ?? 0 : 0);
      const v = (value ?? 0) >>> 0;
      const kept = [];
      for (const a of s.addrs) {
        const cur = read(a);                       // null = no longer decodes (bcd/digits)
        const prev = s.prev ? s.prev.get(a) : undefined;
        let ok = false;
        switch (compare) {
          case "eq":        ok = cur === v; break;
          case "gt":        ok = cur !== null && cur > v; break;
          case "lt":        ok = cur !== null && cur < v; break;
          case "changed":   ok = prev !== undefined && cur !== prev; break;
          case "unchanged": ok = prev !== undefined && cur === prev; break;
          case "inc":       ok = cur !== null && prev !== undefined && cur > prev; break;
          case "dec":       ok = cur !== null && prev !== undefined && cur < prev; break;
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
          ? "0 left — narrowed too far (wrong op, or the value moved between reads — e.g. the scene changed/player died mid-step; screenshot before blaming the compare). Re-seed with memory({op:'search'}). If the on-screen number narrows to 0 on a correct op, it may be stored as BCD/digits, not binary — re-seed with as:'bcd' (a SNES timer hunt went 22 raw candidates → 1 in one 'dec' pass that way)."
          : kept.length <= 2
          ? "Down to 1-2 — confirm: memory({op:'write', region, offset, hex:'..'}) and watch the screen change."
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
    "search → {value, size?, as?, region?}; " +
    "searchNext → {compare, value?}.\n" +
    `• op:'read' — bytes as a \`hex\` string. ≤${INLINE_HEX_LIMIT}B come back inline; >${INLINE_HEX_LIMIT}B need \`outputPath\` (RAW bytes written → {path,bytes}) or \`inline:true\`. BATCH: \`offsets\` (addresses or {offset,length}) reads many non-contiguous spots in ONE call → reads:[{offset,length,hex}]. (Genesis video_ram is raw host-LE word-swapped — not a direct tile map; use tiles({op:'pixels'}).)\n` +
    "• op:'write' — pass payload as `hex` (e.g. 'deadbeef') OR `base64` — **NOT `data`, `bytes`, or an array (those are REJECTED with guidance).** hex for byte patterns, base64 for binary blobs.\n" +
    "• op:'readCart' — read the LOADED CARTRIDGE ROM image ('is the emulator running my patched bytes?'). With `findHex` it SCANS the whole image for a byte pattern and maps every hit to a CPU address (call-site hunts: '20 3C 87' finds every jsr $873C). For un-banked platforms (Genesis/GB/SMS/Lynx/PCE) the file `offset` IS the CPU ROM address; **NES/SNES skip the header and reach bytes through a mapper, so `mapped:true`+note say the offset is not a flat CPU address.**\n" +
    "• op:'snapshot' — capture a baseline of `region` (server RAM, keyed by `name`) to later diff. The 'which bytes did THIS event touch?' workflow: snapshot → trigger event → op:'diff'.\n" +
    "• op:'diff' — compare a region against a snapshot baseline → the CHANGED bytes. DEFAULT `view:'summary'` is a CLUSTERED summary (+ stride detection — '4 islands at stride 0x80' = a struct array) so a churny gameplay diff doesn't flood context; `view:'raw'` = the per-byte before/after list.\n" +
    "• op:'classify' — heuristically classify the bytes at an offset BEFORE you trust a 'found table'. **Kills the classic trap: a run that 'matches' your stats is often ASCII TEXT (bytes 82/79/68 = 'ROD' from a taunt string) or code.** Returns looksLike/printableRatio/entropy/asciiPreview/confidence.\n" +
    "• op:'search' — seed the iterative RAM value search (Cheat Engine / RetroArch style): all addresses currently holding `value` (`size` 1/2/4 bytes, region's endianness). The primitive for 'the screen shows X, find its RAM address' — better than snapshot+diff for this. STORED ≠ DISPLAYED is common — `as:'bcd'` (packed BCD scores) and `as:'digits'` (one byte per on-screen digit at ANY constant tile base, auto-detected per candidate) search those representations directly; for displayed−1 lives or ÷10 scores just seed the transformed number.\n" +
    "• op:'searchUnknown' — the UNKNOWN-INITIAL-VALUE hunt (Cheat Engine's 'Unknown initial value'): seed the WHOLE region as candidates with NO value, then narrow across in-game events with op:'searchNext' compare 'dec'/'inc'/'unchanged'/'changed'/'gt'/'lt'. THE way to find a value you can't see (lives/timer/ammo not on the HUD): searchUnknown → lose a life → searchNext compare:'dec' → repeat. Use this when you don't know the number; use op:'search' when you do.\n" +
    "• op:'searchNext' — narrow the active candidate list against CURRENT memory. `compare`: 'eq'/'gt'/'lt' (need `value`), 'changed'/'unchanged'/'inc'/'dec' (vs the previous read — usable as the FIRST narrow too; baselines are recorded at seed). Comparisons happen in the seed's `as` representation. Repeat until 1-2 remain, then confirm with op:'write'. (For values an INPUT drives — position, velocity — op:'diffRuns' is usually one call instead of a narrowing loop.)",
    {
      op: z.enum(["read", "write", "readCart", "snapshot", "diff", "diffRuns", "classify", "search", "searchUnknown", "searchNext"])
        .describe("read=bytes→hex; write=hex/base64→region; readCart=loaded cart ROM image; snapshot=capture a baseline; diff=changed bytes vs a baseline; diffRuns=run the SAME start state twice under two different held inputs and return only the DIVERGENT bytes (THE input→RAM mapping primitive — replaces save/run/dump/restore/run/dump/python-diff); classify=what kind of data is here; search=seed a value search (you know the number); searchUnknown=seed the whole region (you DON'T know the number); searchNext=narrow either."),
      region: z.enum(REGIONS).optional().describe("Memory region. Required for read/write/snapshot/diff; defaults to system_ram for classify/search. (readCart targets the cart ROM image, not a region.)"),
      offset: z.number().int().min(0).default(0).describe("Byte offset within the region (read/write/snapshot/classify) or the cart ROM image (readCart)."),
      length: z.number().int().min(1).max(1 << 20).optional().describe("Bytes to read (max 1MB). op:read default 1; op:readCart default 16; op:snapshot default = whole region from offset; op:classify default 256."),
      cpuAddress: z.number().int().min(0).optional().describe("op:readCart (NES/SNES) — read by a BANKED CPU ADDRESS instead of a flat offset (the inverse of the breakpoint result's bank/prgOffset). e.g. read a jump table at $8654 in bank 6: {op:'readCart', cpuAddress:0x8654, bank:6}. A $C000+ NES address resolves to the fixed top bank. Saves the cpuAddr-0x8000+bank*0x4000 hand-arithmetic."),
      bank: z.number().int().min(0).optional().describe("op:readCart with cpuAddress — which 16KB PRG bank is mapped into the switchable $8000-$BFFF window (NES). Ignored for $C000+ (fixed top bank) and for non-banked ROMs."),
      mapper: z.enum(["lorom", "hirom"]).optional().describe("op:readCart with cpuAddress (SNES) — force LoROM/HiROM mapping if auto-detect is wrong."),
      offsets: offsetsShape.optional().describe("op:read BATCH — a list of addresses (each read `length` bytes, default 1) or {offset,length} objects → reads:[{offset,length,hex}]. Takes precedence over offset/length."),
      compact: z.boolean().optional().describe("op:read with `offsets` — return reads as ONE {\"0xOFF\": \"hex\"} map instead of an object per read (~4x fewer tokens for the sample-N-flags pattern)."),
      findHex: z.string().optional().describe("op:'readCart' — byte-pattern SCAN over the loaded cart image (even-length hex, spaces/$ ok — e.g. '20 3C 87' = jsr $873C). Returns matches as {fileOffset, cpuAddress[, bank]} — the offset→bank:addr mapping done for you. THE call-site hunt for annotation work; replaces scripting over the ROM file."),
      maxMatches: z.number().int().min(1).max(1000).optional().describe("op:'readCart' findHex — cap on returned matches (default 100; truncated:true when hit)."),
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
      minDelta: z.number().int().min(1).max(255).optional().describe("op:diff — ignore changes where |after-before| < minDelta (filters RNG/counter wiggle so a position byte that moved by the entity's speed stands out)."),
      changeDir: z.enum(["inc", "dec"]).optional().describe("op:diff — keep only bytes that went UP ('inc', after>before) or DOWN ('dec', after<before). The lives/score/ammo hunt: a death window's 'dec' bytes are the candidates."),
      deltaEq: z.number().int().min(-255).max(255).optional().describe("op:diff — keep only bytes whose signed change (after-before) is EXACTLY this. e.g. deltaEq:-1 = 'decreased by one' (lost a life); deltaEq:10 = '+10 score tick'."),
      beforeMin: z.number().int().min(0).max(255).optional().describe("op:diff — keep only bytes whose BEFORE value was >= this."),
      beforeMax: z.number().int().min(0).max(255).optional().describe("op:diff — keep only bytes whose BEFORE value was <= this (e.g. beforeMax:9 = a small counter like lives, not a coordinate)."),
      afterMin: z.number().int().min(0).max(255).optional().describe("op:diff — keep only bytes whose AFTER value was >= this."),
      afterMax: z.number().int().min(0).max(255).optional().describe("op:diff — keep only bytes whose AFTER value was <= this."),
      frames: z.number().int().min(1).max(100000).default(60).describe("op:diffRuns — frames to run EACH scenario from the same start state."),
      portsA: z.array(z.record(z.string(), z.boolean())).max(2).optional().describe("op:diffRuns — held input for run A (e.g. [{right:true}]). Default released."),
      portsB: z.array(z.record(z.string(), z.boolean())).max(2).optional().describe("op:diffRuns — held input for run B. Default released — A-vs-idle is the classic 'which byte does this input drive?' probe."),
      // search / searchNext
      value: z.number().int().optional().describe("op:search — the value the screen shows now. op:searchNext — required for compare 'eq'/'gt'/'lt'."),
      size: z.number().int().min(1).max(4).default(1).describe("op:search — value width in bytes: 1 (stats/lives), 2 (scores/timers), 4 (big counters). Ignored for as:'digits' (width = the value's digit count)."),
      as: z.enum(["raw", "bcd", "digits"]).default("raw").describe("op:search — value representation: 'raw' (binary int, region endianness), 'bcd' (packed BCD, 2 decimal digits/byte — common for NES scores), 'digits' (one byte per ON-SCREEN digit, MSD first, any constant tile base — HUD/tile-index score buffers; the matched base is reported per candidate). searchNext compares in the SAME representation automatically."),
      compare: z.enum(["eq", "changed", "unchanged", "inc", "dec", "gt", "lt"]).optional().describe("op:searchNext — eq=now equals `value`; changed/unchanged vs the last read; inc/dec=went up/down. All of these work as the FIRST narrow too (baselines are recorded at seed). gt/lt=now >/< `value`."),
      maxCandidates: z.number().int().min(1).max(8192).default(64).describe("op:search/searchNext — cap the candidates RETURNED (the full list is kept server-side; `count` is the true total)."),
      // shared output
      outputPath: z.string().optional().describe(`op:read/readCart — write RAW bytes here. Required for reads >${INLINE_HEX_LIMIT}B unless inline. Small reads honor it too (writes file AND returns hex), so 'dump to disk then diff two files' works at any size. (Ignored with offsets.) op:diff — write the FULL diff JSON here regardless of size (so a big diff routes to YOUR path, not a harness path).`),
      inline: z.boolean().default(false).describe(`op:read/readCart — for reads >${INLINE_HEX_LIMIT}B, return the hex in the response instead of writing to disk.`),
      echo: z.boolean().default(true).describe("op:read/readCart with outputPath — false = return only {path, bytes} with NO inline hex (keeps a 2-4KB dump out of context; the raw bytes are in the file). op:diff with outputPath — false = return only the slim envelope (counts + path), omitting the changes/clusters array."),
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
        case "diffRuns": {
          if (!args.region) throw new Error("memory({op:'diffRuns'}): `region` is required.");
          return await memDiffRuns(sessionKey, args);
        }
        case "diff": {
          if (!args.region) throw new Error("memory({op:'diff'}): `region` is required.");
          return await memDiff(sessionKey, args);
        }
        case "classify":   return await memClassify(sessionKey, args);
        case "search": {
          if (args.value == null) throw new Error("memory({op:'search'}): `value` is required (use op:'searchUnknown' for an unknown-value hunt).");
          return await memSearch(sessionKey, args);
        }
        case "searchUnknown": return await memSearchUnknown(sessionKey, args);
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
const snapKey = (region, name) => region + "" + name;

/** Bytes from `offset` to the end of the region — for a whole-region snapshot
 *  when no explicit length is given. Uses the core-reported region size. */
function regionLength(host, region, offset) {
  const size = host.regionSize ? host.regionSize(region) : 0;
  const len = size - offset;
  if (len <= 0) throw new Error(`snapshotMemory: offset ${offset} is past the end of region '${region}' (size ${size}).`);
  return len;
}
