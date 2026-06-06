// Shared values and small helpers for the libretro host harness.
// JSDoc typedefs serve as the lingua franca between host / MCP / platform modules.

/** @typedef {"cartridge" | "disk" | "tape" | "program"} MediaKind */

/**
 * @typedef {"system_ram" | "save_ram" | "video_ram" | "rtc"
 *   | "nes_nametables" | "nes_palette" | "nes_oam" | "nes_chr"
 *   | "nes_apu_regs" | "nes_cpu_regs" | "nes_ppu_regs"
 *   | "snes_oam" | "snes_cgram" | "snes_aram" | "snes_fillram"
 *   | "genesis_cram" | "genesis_vsram" | "genesis_vdp_regs"
 *   | "genesis_z80_ram" | "genesis_m68k" | "genesis_ym2612" | "genesis_psg"
 *   | "sms_vram" | "sms_cram" | "sms_vdp_regs" | "sms_z80_regs"
 *   | "gg_vram" | "gg_cram"
 *   | "gb_vram" | "gb_oam" | "gb_io" | "gb_hram"
 *   | "gb_bgpdata" | "gb_objpdata" | "gb_cpu_regs"
 *   | "a26_tia_regs" | "a26_cpu_regs"
 *   | "a78_cpu_regs"
 *   | "c64_color_ram" | "c64_vic_regs" | "c64_sid_regs"
 *   | "c64_cia1_regs" | "c64_cia2_regs" | "c64_cpu_regs"
 *   | "gba_cpu_regs" | "gba_io_regs" | "gba_palette" | "gba_oam"
 *   | "lynx_cpu_regs" | "lynx_hw_regs"
 *   | "pce_vdc_vram" | "pce_vdc_satb" | "pce_vdc_regs"
 *   | "pce_vce_palette" | "pce_cpu_regs" | "pce_psg_regs"
 *   | "msx_vram" | "msx_vdp_regs" | "msx_vdp_status"
 *   | "msx_palette" | "msx_cpu_regs" | "msx_psg_regs"
 * } MemoryRegion
 */

export const RetroMemory = {
  SAVE_RAM: 0,
  RTC: 1,
  SYSTEM_RAM: 2,
  VIDEO_RAM: 3,
  // romdev extensions exposed by our patched cores. These IDs are
  // honored only by cores we control (fceumm, snes9x, genesis_plus_gx);
  // other cores return null/0 from retro_get_memory_data.
  NES_NAMETABLES:     0x100,
  NES_PALETTE:        0x101,
  NES_OAM:            0x102,
  NES_CHR:            0x103,
  NES_APU_REGS:       0x104,
  NES_CPU_REGS:       0x105,
  NES_PPU_REGS:       0x106,
  SNES_OAM:           0x110,
  SNES_CGRAM:         0x111,
  SNES_ARAM:          0x112,
  SNES_FILLRAM:       0x113,
  GENESIS_CRAM:       0x120,
  GENESIS_VSRAM:      0x121,
  GENESIS_VDP_REGS:   0x122,
  GENESIS_Z80_RAM:    0x123,
  GENESIS_M68K:       0x124,
  GENESIS_YM2612:     0x125,
  GENESIS_PSG:        0x126,
  SMS_VRAM:           0x130,
  SMS_CRAM:           0x131,
  SMS_VDP_REGS:       0x132,
  SMS_Z80_REGS:       0x133,
  GG_VRAM:            0x134,
  GG_CRAM:            0x135,
  GB_VRAM:            0x140,
  GB_OAM:             0x141,
  GB_IO:              0x142,
  GB_HRAM:            0x143,
  GB_BGPDATA:         0x144,
  GB_OBJPDATA:        0x145,
  GB_CPU_REGS:        0x146,
  A78_CPU_REGS:       0x150,
  A26_TIA_REGS:       0x160,
  A26_CPU_REGS:       0x161,
  C64_COLOR_RAM:      0x170,
  C64_VIC_REGS:       0x171,
  C64_SID_REGS:       0x172,
  C64_CIA1_REGS:      0x173,
  C64_CIA2_REGS:      0x174,
  C64_CPU_REGS:       0x175,
  // GBA (mgba): CPU snapshot + the IO page (video AND audio regs) + palette + OAM.
  GBA_CPU_REGS:       0x180,
  GBA_IO_REGS:        0x181,
  GBA_PALETTE:        0x182,
  GBA_OAM:            0x183,
  // Lynx (handy): CPU snapshot + the $FC00-$FDFF Suzy/Mikey HW register window
  // (sprite regs, LCD control, audio $FD20-$FD3F, palette $FDA0-$FDBF).
  LYNX_CPU_REGS:      0x190,
  LYNX_HW_REGS:       0x191,
  // PC Engine / TurboGrafx-16 (geargrafx): HuC6270 VDC VRAM + sprite attribute
  // table + 20-entry register file; HuC6260 VCE 9-bit-GRB color table; HuC6280
  // CPU register snapshot.
  PCE_VDC_VRAM:       0x1A0,
  PCE_VDC_SATB:       0x1A1,
  PCE_VDC_REGS:       0x1A2,
  PCE_VCE_PALETTE:    0x1A3,
  PCE_CPU_REGS:       0x1A4,
  PCE_PSG_REGS:       0x1A5,
  // MSX / MSX2 (blueMSX): V9938 VDP VRAM (up to 192KB) + 64-entry register file
  // + status registers; 16-entry 9-bit-GRB palette; Z80/R800 CPU snapshot.
  MSX_VRAM:           0x1C0,
  MSX_VDP_REGS:       0x1C1,
  MSX_VDP_STATUS:     0x1C2,
  MSX_PALETTE:        0x1C3,
  MSX_CPU_REGS:       0x1C4,
  MSX_PSG_REGS:       0x1C5,
};

/** @type {Record<MemoryRegion, number>} */
export const MemoryRegionToRetro = {
  save_ram: RetroMemory.SAVE_RAM,
  rtc: RetroMemory.RTC,
  system_ram: RetroMemory.SYSTEM_RAM,
  video_ram: RetroMemory.VIDEO_RAM,
  nes_nametables: RetroMemory.NES_NAMETABLES,
  nes_palette: RetroMemory.NES_PALETTE,
  nes_oam: RetroMemory.NES_OAM,
  nes_chr: RetroMemory.NES_CHR,
  nes_apu_regs: RetroMemory.NES_APU_REGS,
  nes_cpu_regs: RetroMemory.NES_CPU_REGS,
  nes_ppu_regs: RetroMemory.NES_PPU_REGS,
  snes_oam: RetroMemory.SNES_OAM,
  snes_cgram: RetroMemory.SNES_CGRAM,
  snes_aram: RetroMemory.SNES_ARAM,
  snes_fillram: RetroMemory.SNES_FILLRAM,
  genesis_cram: RetroMemory.GENESIS_CRAM,
  genesis_vsram: RetroMemory.GENESIS_VSRAM,
  genesis_vdp_regs: RetroMemory.GENESIS_VDP_REGS,
  genesis_z80_ram: RetroMemory.GENESIS_Z80_RAM,
  genesis_m68k: RetroMemory.GENESIS_M68K,
  genesis_ym2612: RetroMemory.GENESIS_YM2612,
  genesis_psg: RetroMemory.GENESIS_PSG,
  sms_vram: RetroMemory.SMS_VRAM,
  sms_cram: RetroMemory.SMS_CRAM,
  sms_vdp_regs: RetroMemory.SMS_VDP_REGS,
  sms_z80_regs: RetroMemory.SMS_Z80_REGS,
  gg_vram: RetroMemory.GG_VRAM,
  gg_cram: RetroMemory.GG_CRAM,
  gb_vram: RetroMemory.GB_VRAM,
  gb_oam: RetroMemory.GB_OAM,
  gb_io: RetroMemory.GB_IO,
  gb_hram: RetroMemory.GB_HRAM,
  gb_bgpdata: RetroMemory.GB_BGPDATA,
  gb_objpdata: RetroMemory.GB_OBJPDATA,
  gb_cpu_regs: RetroMemory.GB_CPU_REGS,
  a78_cpu_regs: RetroMemory.A78_CPU_REGS,
  a26_tia_regs: RetroMemory.A26_TIA_REGS,
  a26_cpu_regs: RetroMemory.A26_CPU_REGS,
  c64_color_ram: RetroMemory.C64_COLOR_RAM,
  c64_vic_regs:  RetroMemory.C64_VIC_REGS,
  c64_sid_regs:  RetroMemory.C64_SID_REGS,
  c64_cia1_regs: RetroMemory.C64_CIA1_REGS,
  c64_cia2_regs: RetroMemory.C64_CIA2_REGS,
  c64_cpu_regs:  RetroMemory.C64_CPU_REGS,
  gba_cpu_regs:  RetroMemory.GBA_CPU_REGS,
  gba_io_regs:   RetroMemory.GBA_IO_REGS,
  gba_palette:   RetroMemory.GBA_PALETTE,
  gba_oam:       RetroMemory.GBA_OAM,
  lynx_cpu_regs: RetroMemory.LYNX_CPU_REGS,
  lynx_hw_regs:  RetroMemory.LYNX_HW_REGS,
  pce_vdc_vram:    RetroMemory.PCE_VDC_VRAM,
  pce_vdc_satb:    RetroMemory.PCE_VDC_SATB,
  pce_vdc_regs:    RetroMemory.PCE_VDC_REGS,
  pce_vce_palette: RetroMemory.PCE_VCE_PALETTE,
  pce_cpu_regs:    RetroMemory.PCE_CPU_REGS,
  pce_psg_regs:    RetroMemory.PCE_PSG_REGS,
  msx_vram:        RetroMemory.MSX_VRAM,
  msx_vdp_regs:    RetroMemory.MSX_VDP_REGS,
  msx_vdp_status:  RetroMemory.MSX_VDP_STATUS,
  msx_palette:     RetroMemory.MSX_PALETTE,
  msx_cpu_regs:    RetroMemory.MSX_CPU_REGS,
  msx_psg_regs:    RetroMemory.MSX_PSG_REGS,
};

/**
 * Per-port controller state (subset of libretro RETRO_DEVICE_JOYPAD).
 * @typedef {Object} PortInput
 * @property {boolean} [up]
 * @property {boolean} [down]
 * @property {boolean} [left]
 * @property {boolean} [right]
 * @property {boolean} [a]
 * @property {boolean} [b]
 * @property {boolean} [x]
 * @property {boolean} [y]
 * @property {boolean} [l]
 * @property {boolean} [r]
 * @property {boolean} [l2]
 * @property {boolean} [r2]
 * @property {boolean} [l3]
 * @property {boolean} [r3]
 * @property {boolean} [start]
 * @property {boolean} [select]
 */

/**
 * @typedef {Object} FrameInput
 * @property {PortInput[]} ports
 */

/**
 * @typedef {Object} LoadMediaArgs
 * @property {string} platform
 * @property {string} path
 * @property {MediaKind} [mediaKind]
 */

/**
 * @typedef {Object} HostStatus
 * @property {string | null} platform
 * @property {string | null} corePath
 * @property {string | null} mediaPath
 * @property {MediaKind | null} mediaKind
 * @property {boolean} loaded
 * @property {boolean} paused
 * @property {number} frameCount
 * @property {number} fbWidth
 * @property {number} fbHeight
 */

/**
 * @typedef {Object} ScreenshotResult
 * @property {number} width
 * @property {number} height
 * @property {string} pngBase64 base64-encoded PNG.
 */

/**
 * Default mediaKind for a platform when caller doesn't specify.
 * Consoles default to cartridge; C64 defaults to program (`.prg`).
 * @param {string} platform
 * @returns {MediaKind}
 */
export function defaultMediaKind(platform) {
  switch (platform) {
    case "c64":
      return "program";
    default:
      return "cartridge";
  }
}

/**
 * Cross-platform face button names. Each platform's diamond is mapped to
 * compass directions in the physical layout the player sees:
 *
 *           north
 *     west        east
 *           south
 *
 * Per-platform translation to libretro button ids:
 *
 *   NES / Game Boy:  east=A, west=B  (north/south have no hardware button)
 *   SNES:            north=X, east=A, south=B, west=Y
 *   Genesis 3-btn:   east=C, south=B, west=A  (north has no hardware button)
 *   Genesis 6-btn:   north=Y, east=C, south=B, west=A
 *   GBA:             east=A, south=B  (north/west via L/R or none)
 *
 * @type {Record<string, { north?: keyof PortInput, east?: keyof PortInput, south?: keyof PortInput, west?: keyof PortInput }>}
 */
export const FACE_BUTTON_MAP = {
  nes:       { east: "a", west: "b" },
  gb:        { east: "a", west: "b" },
  gbc:       { east: "a", west: "b" },
  snes:      { north: "x", east: "a", south: "b", west: "y" },
  genesis:   { east: "a", south: "b", west: "y" },  // libretro maps Genesis A/B/C onto y/b/a respectively
  sms:       { east: "a", west: "b" },
  gg:        { east: "a", west: "b" },
  gba:       { east: "a", south: "b" },
  atari2600: { south: "b" },         // 2600 has one button
  atari7800: { east: "a", south: "b" },
  lynx:      { east: "a", south: "b" },
  c64:       { south: "b" },         // C64 joystick fire
  pce:       { east: "a", west: "b" },  // PC Engine pad: libretro A=button I, B=button II (Run=start, Select=select)
  msx:       { east: "a", west: "b" },  // MSX joystick: libretro A=trigger 1, B=trigger 2
};

/**
 * Resolve a face-button name (north/east/south/west) for a platform to its
 * underlying libretro button name. Returns null if the platform doesn't have
 * a button in that direction.
 *
 * @param {string} platform
 * @param {"north" | "east" | "south" | "west"} face
 * @returns {string | null}
 */
export function faceToButton(platform, face) {
  const map = FACE_BUTTON_MAP[platform];
  if (!map) return null;
  return map[face] ?? null;
}

/**
 * Map a PortInput object to a libretro JOYPAD bitmask. Accepts both the raw
 * libretro names (a/b/x/y/l/r/l2/r2/l3/r3/select/start/up/down/left/right)
 * and the cross-platform spatial names (north/east/south/west). Spatial names
 * are resolved through `platform`; if no platform is given, they're ignored.
 *
 * @param {PortInput & { north?: boolean, east?: boolean, south?: boolean, west?: boolean }} input
 * @param {string} [platform] for resolving spatial names
 * @returns {number}
 */
export function portInputToMask(input, platform) {
  if (!input) return 0;
  let m = 0;

  // Spatial → libretro name (resolved through platform map).
  const merged = { ...input };
  if (platform) {
    for (const face of ["north", "east", "south", "west"]) {
      if (input[face]) {
        const target = faceToButton(platform, face);
        if (target) merged[target] = true;
      }
    }
  }

  if (merged.b) m |= 1 << 0;
  if (merged.y) m |= 1 << 1;
  if (merged.select) m |= 1 << 2;
  if (merged.start) m |= 1 << 3;
  if (merged.up) m |= 1 << 4;
  if (merged.down) m |= 1 << 5;
  if (merged.left) m |= 1 << 6;
  if (merged.right) m |= 1 << 7;
  if (merged.a) m |= 1 << 8;
  if (merged.x) m |= 1 << 9;
  if (merged.l) m |= 1 << 10;
  if (merged.r) m |= 1 << 11;
  if (merged.l2) m |= 1 << 12;
  if (merged.r2) m |= 1 << 13;
  if (merged.l3) m |= 1 << 14;
  if (merged.r3) m |= 1 << 15;
  return m;
}
