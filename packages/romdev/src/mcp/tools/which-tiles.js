// whichTilesAreRendered — at the current emulator state, walk the BG nametable
// + OAM and return the set of tile IDs actually being drawn this frame.
//
// Replaces the "extract sprite sheet then guess by eye which tiles are which"
// workflow. Lets an agent sample the same call across game states (title,
// gameplay, menu) and build their own tile-to-content map.

import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";

function resolvePlatform(host, requested) {
  const p = requested ?? host.status.platform;
  if (!p) throw new Error("no platform specified and no host loaded");
  return p;
}

function summariseTileSet(ids) {
  if (ids.size === 0) return { count: 0, ids: [], ranges: [] };
  const sorted = [...ids].sort((a, b) => a - b);
  // Coalesce contiguous runs of tile IDs into [start, end] ranges.
  const ranges = [];
  let runStart = sorted[0];
  let runEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === runEnd + 1) {
      runEnd = sorted[i];
    } else {
      ranges.push([runStart, runEnd]);
      runStart = sorted[i];
      runEnd = sorted[i];
    }
  }
  ranges.push([runStart, runEnd]);
  return {
    count: ids.size,
    ids: sorted,
    idsHex: sorted.map((n) => "0x" + n.toString(16).toUpperCase().padStart(2, "0")),
    ranges: ranges.map(([s, e]) => s === e
      ? "0x" + s.toString(16).toUpperCase().padStart(2, "0")
      : "0x" + s.toString(16).toUpperCase().padStart(2, "0") + "-0x" + e.toString(16).toUpperCase().padStart(2, "0")),
  };
}

export function registerWhichTilesTools(server, z, sessionKey) {
  server.tool(
    "whichTilesAreRendered",
    "Use this to map tile IDs → game assets: walks the current frame's BG nametable + OAM and returns the " +
    "set of tile IDs actually being drawn ({background, sprite, combined}, each with ids/idsHex/ranges). " +
    "ROM-hack trick: call it at the title screen, then again in gameplay, and SUBTRACT the sets — what's " +
    "unique to gameplay is your in-game art. Supported: nes, snes (pass `snesTilemapBaseByte` for BG — " +
    "snes9x hides the PPU regs), gb, gbc, sms, gg, genesis, c64.",
    {
      platform: z.string().optional(),
      snesTilemapBaseByte: z.number().int().min(0).optional().describe("SNES only: byte offset into VRAM of a BG tilemap (BGxSC base). If set, its referenced tile IDs are added to `background`. snes9x can't auto-detect this."),
      snesMapWidth: z.union([z.literal(32), z.literal(64)]).default(32).describe("SNES only: tilemap width in tiles (with snesTilemapBaseByte)."),
      snesMapHeight: z.union([z.literal(32), z.literal(64)]).default(32).describe("SNES only: tilemap height in tiles (with snesTilemapBaseByte)."),
    },
    safeTool(async ({ platform, snesTilemapBaseByte, snesMapWidth, snesMapHeight }) => {
      const host = getHost(sessionKey);
      const p = resolvePlatform(host, platform);
      const bg = new Set();
      const sprite = new Set();

      if (p === "nes") {
        // BG: read both nametables ($2000 + $2400), first 960 bytes of each
        // (32×30 tiles; the remaining 64 bytes are the attribute table, not
        // tile IDs).
        const nt = host.readMemory("nes_nametables", 0, 2048);
        for (let i = 0; i < 960; i++) bg.add(nt[i]);
        for (let i = 1024; i < 1024 + 960; i++) bg.add(nt[i]);

        // OAM: 64 entries, tile is byte 1.
        const oam = host.readMemory("nes_oam", 0, 256);
        for (let i = 0; i < 64; i++) {
          const y = oam[i * 4 + 0];
          if (y >= 0xF0) continue; // off-screen
          sprite.add(oam[i * 4 + 1]);
        }
      } else if (p === "gb" || p === "gbc") {
        const vram = host.readMemory("gb_vram", 0, 0x4000);
        const io = host.readMemory("gb_io", 0, 0x80);
        // LCDC bit 3 = BG map area ($9800 or $9C00); bit 6 = window map area.
        const lcdc = io[0x40];
        const bgMapBase = (lcdc & 0x08) ? 0x1C00 : 0x1800;
        const windowMapBase = (lcdc & 0x40) ? 0x1C00 : 0x1800;
        for (let i = 0; i < 1024; i++) bg.add(vram[bgMapBase + i]);
        for (let i = 0; i < 1024; i++) bg.add(vram[windowMapBase + i]);

        // OAM at $FE00 = gb_oam region; 40 entries × 4 bytes.
        const oam = host.readMemory("gb_oam", 0, 160);
        for (let i = 0; i < 40; i++) {
          const y = oam[i * 4 + 0];
          if (y === 0 || y >= 160) continue; // off-screen
          sprite.add(oam[i * 4 + 2]); // byte 2 = tile index
        }
      } else if (p === "sms" || p === "gg") {
        const vram = host.readMemory("video_ram", 0, 0x4000);
        const regs = host.readMemory("sms_vdp_regs", 0, 16);
        // VDP reg 2 bits 1-3 = nametable address (× $400)
        const nameBase = ((regs[2] >> 1) & 0x07) * 0x400;
        // 32×24 tiles, 2 bytes each (lower = tile id 0-255 lo, upper = id-hi + attrs)
        for (let row = 0; row < 24; row++) {
          for (let col = 0; col < 32; col++) {
            const o = nameBase + (row * 32 + col) * 2;
            const tile = vram[o] | ((vram[o + 1] & 0x01) << 8);
            bg.add(tile);
          }
        }
        // SAT base from reg 5; SMS sprites use one byte per entry as tile id
        // (entries 0x80..0xFF are y-pos terminator).
        const satBase = (regs[5] & 0x7E) * 0x80;
        for (let i = 0; i < 64; i++) {
          const y = vram[satBase + i];
          if (y === 0xD0) break; // terminator
          const tile = vram[satBase + 0x80 + i * 2 + 1];
          sprite.add(tile);
        }
      } else if (p === "snes") {
        // Sprites: always available from OAM.
        const oam = host.readMemory("snes_oam", 0, 544);
        const { decodeOAM, snesTilemapUsage } = await import("../../platforms/snes/ppu.js");
        const sprites = decodeOAM(oam);
        for (const s of sprites) {
          if (!s.visible) continue;
          sprite.add(s.tile);
        }
        // BG: only if the caller supplies a tilemap base — snes9x doesn't
        // expose BGxSC, so we can't auto-locate the map.
        if (snesTilemapBaseByte != null) {
          const vram = host.readMemory("video_ram", 0, 0x10000);
          const usage = snesTilemapUsage(vram, {
            tilemapBaseByte: snesTilemapBaseByte,
            mapWidth: snesMapWidth,
            mapHeight: snesMapHeight,
          });
          for (const t of usage.used) bg.add(t);
        }
      } else if (p === "genesis") {
        const { genesisTileUsage } = await import("../../platforms/genesis/vdp.js");
        const usage = genesisTileUsage(host);
        for (const t of usage.planeA) bg.add(t);
        for (const t of usage.planeB) bg.add(t);
        for (const t of usage.sprites) sprite.add(t);
      } else if (p === "c64") {
        // C64 "tiles" are character codes in screen RAM. Resolve the screen
        // RAM base: VIC bank (CIA2 port A bits 0-1, inverted) × $4000 plus
        // the screen-RAM pointer in $D018 bits 4-7 (× $400). Then read the
        // 40×25 = 1000 char codes from system_ram.
        const { decodeViciiRegs } = await import("../../platforms/c64/vic.js");
        const regs = host.readMemory("c64_vic_regs", 0, 0x2F);
        const vic = decodeViciiRegs(regs);
        const cia2 = host.readMemory("c64_cia2_regs", 0, 16);
        const vicBank = (~cia2[0]) & 0x03;
        const screenBase = vicBank * 0x4000 +
          parseInt(vic.memPointers.screenRamBaseInVicBank.replace("$", ""), 16);
        const screen = host.readMemory("system_ram", screenBase, 1000);
        for (let i = 0; i < 1000; i++) bg.add(screen[i]);
        // C64 sprites are MOBs (pointer-indexed pixel data), not char codes —
        // they don't share the BG character set, so we leave `sprite` empty
        // here. Use inspectSprites for the 8 hardware sprites.
      } else {
        throw new Error(`whichTilesAreRendered: platform '${p}' not yet supported.`);
      }

      const combined = new Set([...bg, ...sprite]);
      return jsonContent({
        platform: p,
        background: summariseTileSet(bg),
        sprite: summariseTileSet(sprite),
        combined: summariseTileSet(combined),
        note: "Sample at multiple game states (title / gameplay / menu) and diff the sets to map tile IDs → game assets.",
      });
    }),
  );
}
