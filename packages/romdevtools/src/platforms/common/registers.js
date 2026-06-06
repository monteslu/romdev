// Hardware register lookup tables for disassembly annotation.
//
// Each platform's table maps an address (16- or 24-bit, hex) to a register
// shorthand like "PPUCTRL". The disassembler walks asm output line-by-line
// and appends `  ; <REG>` whenever an operand resolves to one of these.
//
// Tables are intentionally compact — register *names* only, not full
// descriptions. Agents look up details via the existing input-layout /
// platform-tools when they need bit-level meaning.

/** @typedef {Record<number, string>} RegisterTable */

/** @type {RegisterTable} */
export const NES_REGISTERS = {
  // PPU $2000-$2007 + open-bus mirrors.
  0x2000: "PPUCTRL",
  0x2001: "PPUMASK",
  0x2002: "PPUSTATUS",
  0x2003: "OAMADDR",
  0x2004: "OAMDATA",
  0x2005: "PPUSCROLL",
  0x2006: "PPUADDR",
  0x2007: "PPUDATA",
  // APU $4000-$4017
  0x4000: "SQ1_VOL",
  0x4001: "SQ1_SWEEP",
  0x4002: "SQ1_LO",
  0x4003: "SQ1_HI",
  0x4004: "SQ2_VOL",
  0x4005: "SQ2_SWEEP",
  0x4006: "SQ2_LO",
  0x4007: "SQ2_HI",
  0x4008: "TRI_LINEAR",
  0x400A: "TRI_LO",
  0x400B: "TRI_HI",
  0x400C: "NOISE_VOL",
  0x400E: "NOISE_LO",
  0x400F: "NOISE_HI",
  0x4010: "DMC_FREQ",
  0x4011: "DMC_RAW",
  0x4012: "DMC_START",
  0x4013: "DMC_LEN",
  0x4014: "OAMDMA",
  0x4015: "SND_CHN",
  0x4016: "JOY1",
  0x4017: "JOY2",
};

/** @type {RegisterTable} */
export const SNES_REGISTERS = {
  // PPU regs $2100-$213F
  0x2100: "INIDISP", 0x2101: "OBSEL", 0x2102: "OAMADDL", 0x2103: "OAMADDH",
  0x2104: "OAMDATA", 0x2105: "BGMODE", 0x2106: "MOSAIC",
  0x2107: "BG1SC", 0x2108: "BG2SC", 0x2109: "BG3SC", 0x210A: "BG4SC",
  0x210B: "BG12NBA", 0x210C: "BG34NBA",
  0x210D: "BG1HOFS", 0x210E: "BG1VOFS",
  0x210F: "BG2HOFS", 0x2110: "BG2VOFS",
  0x2111: "BG3HOFS", 0x2112: "BG3VOFS",
  0x2113: "BG4HOFS", 0x2114: "BG4VOFS",
  0x2115: "VMAIN", 0x2116: "VMADDL", 0x2117: "VMADDH",
  0x2118: "VMDATAL", 0x2119: "VMDATAH",
  0x211A: "M7SEL", 0x211B: "M7A", 0x211C: "M7B", 0x211D: "M7C", 0x211E: "M7D",
  0x211F: "M7X", 0x2120: "M7Y",
  0x2121: "CGADD", 0x2122: "CGDATA",
  0x2123: "W12SEL", 0x2124: "W34SEL", 0x2125: "WOBJSEL",
  0x2126: "WH0", 0x2127: "WH1", 0x2128: "WH2", 0x2129: "WH3",
  0x212A: "WBGLOG", 0x212B: "WOBJLOG",
  0x212C: "TM", 0x212D: "TS", 0x212E: "TMW", 0x212F: "TSW",
  0x2130: "CGWSEL", 0x2131: "CGADSUB", 0x2132: "COLDATA", 0x2133: "SETINI",
  0x2134: "MPYL", 0x2135: "MPYM", 0x2136: "MPYH",
  0x2137: "SLHV", 0x2138: "OAMDATAREAD", 0x2139: "VMDATALREAD", 0x213A: "VMDATAHREAD",
  0x213B: "CGDATAREAD", 0x213C: "OPHCT", 0x213D: "OPVCT",
  0x213E: "STAT77", 0x213F: "STAT78",
  // APU I/O
  0x2140: "APUIO0", 0x2141: "APUIO1", 0x2142: "APUIO2", 0x2143: "APUIO3",
  // WRAM access ports
  0x2180: "WMDATA", 0x2181: "WMADDL", 0x2182: "WMADDM", 0x2183: "WMADDH",
  // CPU regs $4200-$420D
  0x4200: "NMITIMEN", 0x4201: "WRIO", 0x4202: "WRMPYA", 0x4203: "WRMPYB",
  0x4204: "WRDIVL", 0x4205: "WRDIVH", 0x4206: "WRDIVB",
  0x4207: "HTIMEL", 0x4208: "HTIMEH", 0x4209: "VTIMEL", 0x420A: "VTIMEH",
  0x420B: "MDMAEN", 0x420C: "HDMAEN", 0x420D: "MEMSEL",
  0x4210: "RDNMI", 0x4211: "TIMEUP", 0x4212: "HVBJOY", 0x4213: "RDIO",
  0x4214: "RDDIVL", 0x4215: "RDDIVH", 0x4216: "RDMPYL", 0x4217: "RDMPYH",
  0x4218: "JOY1L", 0x4219: "JOY1H", 0x421A: "JOY2L", 0x421B: "JOY2H",
  0x421C: "JOY3L", 0x421D: "JOY3H", 0x421E: "JOY4L", 0x421F: "JOY4H",
  // DMA channel registers $4300-$437F (8 channels × $10 each)
  // We tag the channel-0 registers; agents who care about other channels
  // will see "DMAPx" stride patterns and infer.
  0x4300: "DMAP0", 0x4301: "BBAD0",
  0x4302: "A1T0L", 0x4303: "A1T0H", 0x4304: "A1B0",
  0x4305: "DAS0L", 0x4306: "DAS0H", 0x4307: "DAS0B",
  0x4308: "A2A0L", 0x4309: "A2A0H", 0x430A: "NTRL0",
};

/** @type {RegisterTable} */
export const GENESIS_REGISTERS = {
  // VDP control / data ports
  0xC00000: "VDP_DATA", 0xC00002: "VDP_DATA",
  0xC00004: "VDP_CTRL", 0xC00006: "VDP_CTRL",
  0xC00008: "VDP_HVCOUNTER",
  0xC00011: "PSG_OUT",
  // YM2612 (SN76489 PSG via $C00011; YM2612 at $A04000)
  0xA04000: "YM2612_A0", 0xA04001: "YM2612_D0",
  0xA04002: "YM2612_A1", 0xA04003: "YM2612_D1",
  // I/O regs $A10000-$A1001F
  0xA10001: "VERSION",
  0xA10003: "DATA1", 0xA10005: "DATA2",
  0xA10009: "CTRL1", 0xA1000B: "CTRL2",
  // Z80 bus + reset
  0xA11100: "Z80_BUSREQ",
  0xA11200: "Z80_RESET",
};

/** @type {RegisterTable} */
export const GB_REGISTERS = {
  // CPU + system regs $FF00-$FF7F
  0xFF00: "P1_JOYP",
  0xFF01: "SB", 0xFF02: "SC",
  0xFF04: "DIV", 0xFF05: "TIMA", 0xFF06: "TMA", 0xFF07: "TAC",
  0xFF0F: "IF",
  // APU
  0xFF10: "NR10", 0xFF11: "NR11", 0xFF12: "NR12", 0xFF13: "NR13", 0xFF14: "NR14",
  0xFF16: "NR21", 0xFF17: "NR22", 0xFF18: "NR23", 0xFF19: "NR24",
  0xFF1A: "NR30", 0xFF1B: "NR31", 0xFF1C: "NR32", 0xFF1D: "NR33", 0xFF1E: "NR34",
  0xFF20: "NR41", 0xFF21: "NR42", 0xFF22: "NR43", 0xFF23: "NR44",
  0xFF24: "NR50", 0xFF25: "NR51", 0xFF26: "NR52",
  // PPU
  0xFF40: "LCDC", 0xFF41: "STAT",
  0xFF42: "SCY", 0xFF43: "SCX",
  0xFF44: "LY", 0xFF45: "LYC",
  0xFF46: "DMA",
  0xFF47: "BGP", 0xFF48: "OBP0", 0xFF49: "OBP1",
  0xFF4A: "WY", 0xFF4B: "WX",
  // GBC extras
  0xFF4D: "KEY1", 0xFF4F: "VBK",
  0xFF51: "HDMA1", 0xFF52: "HDMA2", 0xFF53: "HDMA3", 0xFF54: "HDMA4", 0xFF55: "HDMA5",
  0xFF56: "RP",
  0xFF68: "BCPS", 0xFF69: "BCPD", 0xFF6A: "OCPS", 0xFF6B: "OCPD",
  0xFF70: "SVBK",
  // Interrupt enable
  0xFFFF: "IE",
};

/**
 * SMS / Game Gear I/O ports + VDP. The Z80 sees these via IN/OUT
 * instructions, not memory-mapped reads, but disassemblers commonly
 * show the port number as an immediate — `out ($BE),a` etc — so
 * annotating those operands is what helps.
 *
 * SMS uses 8-bit ports; we annotate on 8-bit hits. Code that does
 * `out ($BE),a` should pick up `; VDP_DATA`.
 *
 * Key: SMS VDP register *numbers* (0-10) are NOT memory addresses —
 * the agent writes them via VDP_CTRL. We annotate the VDP ports
 * ($BE/$BF) and the I/O ports ($DC/$DD joypad, $3E/$3F memory control,
 * $7E/$7F PSG/V-counter, $C0-$C1 GG-extras).
 *
 * @type {RegisterTable}
 */
export const SMS_REGISTERS = {
  // VDP
  0x00BE: "VDP_DATA",
  0x00BF: "VDP_CTRL",
  // PSG / V counter / H counter
  0x007E: "V_COUNTER",  // read
  0x007F: "H_COUNTER",  // read; same port writes PSG (overloaded)
  // Joypad
  0x00DC: "IO_PORT_A",  // P1 buttons + P2 D-pad
  0x00DD: "IO_PORT_B",  // P2 buttons + reset/cart
  // Memory + cartridge control
  0x003E: "MEMORY_CTRL",
  0x003F: "IO_CTRL",
  // Game Gear extras ($00-$06 + $C0..)
  0x0000: "GG_INPUT",   // GG: start button + region
  0x0001: "GG_OUTPUT",
  0x0002: "GG_DATA_DIR",
  0x0003: "GG_TX_DATA",
  0x0004: "GG_RX_DATA",
  0x0005: "GG_SERIAL_CTRL",
  0x0006: "GG_PSG_STEREO",
  // SMS BIOS / control mirrors (some games hit these)
  0x00F2: "FM_DETECTION",   // Japanese SMS only
};

/**
 * Atari 2600 (TIA + RIOT). Write-side TIA registers $00-$2C, read-side
 * TIA registers $30-$3D, and RIOT registers $280-$297. Most popular
 * names per the dasm convention.
 *
 * @type {RegisterTable}
 */
export const ATARI2600_REGISTERS = {
  // TIA write regs $00-$2C
  0x00: "VSYNC",     0x01: "VBLANK",    0x02: "WSYNC",     0x03: "RSYNC",
  0x04: "NUSIZ0",    0x05: "NUSIZ1",    0x06: "COLUP0",    0x07: "COLUP1",
  0x08: "COLUPF",    0x09: "COLUBK",    0x0A: "CTRLPF",    0x0B: "REFP0",
  0x0C: "REFP1",     0x0D: "PF0",       0x0E: "PF1",       0x0F: "PF2",
  0x10: "RESP0",     0x11: "RESP1",     0x12: "RESM0",     0x13: "RESM1",
  0x14: "RESBL",     0x15: "AUDC0",     0x16: "AUDC1",     0x17: "AUDF0",
  0x18: "AUDF1",     0x19: "AUDV0",     0x1A: "AUDV1",     0x1B: "GRP0",
  0x1C: "GRP1",      0x1D: "ENAM0",     0x1E: "ENAM1",     0x1F: "ENABL",
  0x20: "HMP0",      0x21: "HMP1",      0x22: "HMM0",      0x23: "HMM1",
  0x24: "HMBL",      0x25: "VDELP0",    0x26: "VDELP1",    0x27: "VDELBL",
  0x28: "RESMP0",    0x29: "RESMP1",    0x2A: "HMOVE",     0x2B: "HMCLR",
  0x2C: "CXCLR",
  // TIA read regs $30-$3D
  0x30: "CXM0P",     0x31: "CXM1P",     0x32: "CXP0FB",    0x33: "CXP1FB",
  0x34: "CXM0FB",    0x35: "CXM1FB",    0x36: "CXBLPF",    0x37: "CXPPMM",
  0x38: "INPT0",     0x39: "INPT1",     0x3A: "INPT2",     0x3B: "INPT3",
  0x3C: "INPT4",     0x3D: "INPT5",
  // RIOT regs $280-$297
  0x0280: "SWCHA",   0x0281: "SWACNT",  0x0282: "SWCHB",   0x0283: "SWBCNT",
  0x0284: "INTIM",   0x0285: "INSTAT",
  0x0294: "TIM1T",   0x0295: "TIM8T",   0x0296: "TIM64T",  0x0297: "T1024T",
};

/**
 * Atari 7800 (MARIA + TIA-audio + RIOT). Memory map differs from 2600 —
 * registers live at the bottom of the 6502 address space.
 *
 * @type {RegisterTable}
 */
export const ATARI7800_REGISTERS = {
  // TIA audio regs (subset, $15-$1A — overlap with 2600 names)
  0x15: "AUDC0",     0x16: "AUDC1",     0x17: "AUDF0",     0x18: "AUDF1",
  0x19: "AUDV0",     0x1A: "AUDV1",
  // MARIA regs $20-$3F
  0x20: "BACKGRND",
  0x21: "P0C1",      0x22: "P0C2",      0x23: "P0C3",
  0x25: "WSYNC",
  0x26: "P1C1",      0x27: "P1C2",      0x28: "P1C3",
  0x29: "MSTAT",
  0x2A: "P2C1",      0x2B: "P2C2",      0x2C: "P2C3",
  0x2E: "P3C1",      0x2F: "P3C2",      0x30: "P3C3",
  0x32: "P4C1",      0x33: "P4C2",      0x34: "P4C3",
  0x36: "P5C1",      0x37: "P5C2",      0x38: "P5C3",
  0x3A: "P6C1",      0x3B: "P6C2",      0x3C: "P6C3",
  0x3E: "P7C1",      0x3F: "P7C2",      // P7C3 lives at $40 in some refs
  // DPP (display-list pointer) lives at $84/$85
  0x84: "DPPH",      0x85: "DPPL",
  0x87: "CHARBASE",
  0x88: "OFFSET",
  // MARIA control reg
  0x3C: "CTRL",      // overlaps with P6C3 — convention varies; tag both
  // RIOT (6532) regs at $280
  0x0280: "SWCHA",   0x0281: "SWACNT",  0x0282: "SWCHB",   0x0283: "SWBCNT",
  0x0284: "INTIM",
};

/**
 * Commodore 64 register table — VIC-II ($D000-$D02E), SID ($D400-$D41C),
 * CIA1 ($DC00-$DC0F), CIA2 ($DD00-$DD0F), plus the 6510 IO ports at $00/$01.
 * @type {RegisterTable}
 */
export const C64_REGISTERS = {
  // 6510 internal I/O ports
  0x0000: "D6510",     0x0001: "R6510",
  // VIC-II $D000-$D02E
  0xD000: "SP0X",      0xD001: "SP0Y",      0xD002: "SP1X",      0xD003: "SP1Y",
  0xD004: "SP2X",      0xD005: "SP2Y",      0xD006: "SP3X",      0xD007: "SP3Y",
  0xD008: "SP4X",      0xD009: "SP4Y",      0xD00A: "SP5X",      0xD00B: "SP5Y",
  0xD00C: "SP6X",      0xD00D: "SP6Y",      0xD00E: "SP7X",      0xD00F: "SP7Y",
  0xD010: "MSIGX",     // sprite X bit-8s
  0xD011: "SCROLY",    // control reg 1
  0xD012: "RASTER",
  0xD013: "LPENX",     0xD014: "LPENY",
  0xD015: "SPENA",     // sprite enable
  0xD016: "SCROLX",    // control reg 2
  0xD017: "YXPAND",
  0xD018: "VMCSB",     // memory pointers
  0xD019: "VICIRQ",
  0xD01A: "IRQMASK",
  0xD01B: "SPBGPR",    // sprite-bg priority
  0xD01C: "SPMC",      // sprite multicolor
  0xD01D: "XXPAND",
  0xD01E: "SPSPCL",    // sprite-sprite collision
  0xD01F: "SPBGCL",    // sprite-data collision
  0xD020: "EXTCOL",    // border
  0xD021: "BGCOL0",    // background 0
  0xD022: "BGCOL1",    0xD023: "BGCOL2",    0xD024: "BGCOL3",
  0xD025: "SPMC0",     0xD026: "SPMC1",
  0xD027: "SP0COL",    0xD028: "SP1COL",    0xD029: "SP2COL",    0xD02A: "SP3COL",
  0xD02B: "SP4COL",    0xD02C: "SP5COL",    0xD02D: "SP6COL",    0xD02E: "SP7COL",
  // SID $D400-$D41C
  0xD400: "FRELO1",    0xD401: "FREHI1",    0xD402: "PWLO1",     0xD403: "PWHI1",
  0xD404: "VCREG1",    0xD405: "ATDCY1",    0xD406: "SUREL1",
  0xD407: "FRELO2",    0xD408: "FREHI2",    0xD409: "PWLO2",     0xD40A: "PWHI2",
  0xD40B: "VCREG2",    0xD40C: "ATDCY2",    0xD40D: "SUREL2",
  0xD40E: "FRELO3",    0xD40F: "FREHI3",    0xD410: "PWLO3",     0xD411: "PWHI3",
  0xD412: "VCREG3",    0xD413: "ATDCY3",    0xD414: "SUREL3",
  0xD415: "CUTLO",     0xD416: "CUTHI",     0xD417: "RESON",     0xD418: "SIGVOL",
  0xD419: "POTX",      0xD41A: "POTY",      0xD41B: "RANDOM",    0xD41C: "ENV3",
  // CIA1 $DC00-$DC0F (keyboard + joystick + timers + TOD)
  0xDC00: "CIAPRA",    0xDC01: "CIAPRB",    0xDC02: "CIDDRA",    0xDC03: "CIDDRB",
  0xDC04: "TIMALO",    0xDC05: "TIMAHI",    0xDC06: "TIMBLO",    0xDC07: "TIMBHI",
  0xDC08: "TODTEN",    0xDC09: "TODSEC",    0xDC0A: "TODMIN",    0xDC0B: "TODHRS",
  0xDC0C: "CIASDR",    0xDC0D: "CIAICR",    0xDC0E: "CIACRA",    0xDC0F: "CIACRB",
  // CIA2 $DD00-$DD0F (serial bus + VIC bank select + RS232)
  0xDD00: "CI2PRA",    0xDD01: "CI2PRB",    0xDD02: "C2DDRA",    0xDD03: "C2DDRB",
  0xDD04: "TI2ALO",    0xDD05: "TI2AHI",    0xDD06: "TI2BLO",    0xDD07: "TI2BHI",
  0xDD08: "TO2TEN",    0xDD09: "TO2SEC",    0xDD0A: "TO2MIN",    0xDD0B: "TO2HRS",
  0xDD0C: "CI2SDR",    0xDD0D: "CI2ICR",    0xDD0E: "CI2CRA",    0xDD0F: "CI2CRB",
};

/**
 * Look up the register table for a platform id, or null.
 * @param {string} platform
 * @returns {RegisterTable | null}
 */
export function registersForPlatform(platform) {
  switch (platform) {
    case "nes": return NES_REGISTERS;
    case "snes": return SNES_REGISTERS;
    case "genesis":
    case "megadrive":
    case "md": return GENESIS_REGISTERS;
    case "gb":
    case "gbc": return GB_REGISTERS;
    case "sms":
    case "gg": return SMS_REGISTERS;
    case "atari2600":
    case "a2600": return ATARI2600_REGISTERS;
    case "atari7800":
    case "a7800": return ATARI7800_REGISTERS;
    case "c64": return C64_REGISTERS;
    default: return null;
  }
}
