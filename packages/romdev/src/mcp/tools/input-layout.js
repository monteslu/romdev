// getInputLayout — return per-platform input register/protocol info plus
// the libretro→hardware id mapping. Lets agents writing asm input handlers
// know exactly what each bit/id means.

import { FACE_BUTTON_MAP } from "../../host/types.js";
import { jsonContent, safeTool } from "../util.js";

const HARDWARE_LAYOUTS = {
  nes: {
    register: "$4016 (port 1), $4017 (port 2)",
    protocol: "strobe-and-shift",
    strobe: "Write 1 then 0 to $4016 to latch button state.",
    readSequence: "Each read of $4016 returns the next button in bit 0. Read 8 times.",
    bitOrder: ["A", "B", "Select", "Start", "Up", "Down", "Left", "Right"],
    note: "Bit 0 of each read is the button state. After 8 reads with `lsr ; rol keydown`, keydown holds A in bit 7 ... Right in bit 0.",
    faceButtons: FACE_BUTTON_MAP.nes,
  },
  gb: {
    register: "$FF00 (P1/JOYP)",
    protocol: "row-select",
    strobe: "Write bit 5 low to select directions, bit 4 low to select buttons.",
    readSequence: "Bits 0-3 read low when the corresponding button in the selected row is pressed.",
    bitOrder: [
      "Right/A (bit 0)",
      "Left/B (bit 1)",
      "Up/Select (bit 2)",
      "Down/Start (bit 3)",
    ],
    note: "Active-low. Bit 0 with directions selected = Right; with buttons selected = A.",
    faceButtons: FACE_BUTTON_MAP.gb,
  },
  gbc: {
    register: "$FF00 (P1/JOYP)",
    protocol: "row-select",
    strobe: "Same as Game Boy. CGB adds nothing here.",
    readSequence: "Same as Game Boy.",
    bitOrder: ["Right/A", "Left/B", "Up/Select", "Down/Start"],
    faceButtons: FACE_BUTTON_MAP.gbc,
  },
  snes: {
    register: "$4016 (port 1), $4017 (port 2)",
    protocol: "strobe-and-shift",
    strobe: "Write 1 then 0 to $4016. Same protocol as NES, 16 reads.",
    readSequence: "16 reads per port — first 12 are buttons, last 4 are device-id padding.",
    bitOrder: [
      "B", "Y", "Select", "Start",
      "Up", "Down", "Left", "Right",
      "A", "X", "L", "R",
      "(0)", "(0)", "(0)", "(1)",
    ],
    faceButtons: FACE_BUTTON_MAP.snes,
  },
  genesis: {
    register: "$A10003 (port 1), $A10005 (port 2)",
    protocol: "select-line",
    strobe: "TH bit (bit 6) of CTRL register selects which set of buttons is read.",
    readSequence: "TH=0: read Up/Down/0/0/A/Start. TH=1: read Up/Down/Left/Right/B/C. 6-button pad uses extra TH transitions.",
    bitOrder: ["Up", "Down", "Left/0", "Right/0", "B/A", "C/Start"],
    note: "Bit positions vary by TH state. The libretro JOYPAD maps A/B/C onto Y/B/A respectively (so libretro 'A' = Genesis A, libretro 'B' = Genesis B, libretro 'Y' = Genesis C; libretro 'C' doesn't exist).",
    faceButtons: FACE_BUTTON_MAP.genesis,
  },
  atari2600: {
    register: "SWCHA ($280), INPT4/INPT5 (fire buttons)",
    protocol: "direct-read",
    strobe: "None — bits are wired directly.",
    readSequence: "SWCHA: high nibble = player 1 directions (active-low). INPT4 bit 7 = player 1 fire (active-low).",
    bitOrder: ["P1 Right", "P1 Left", "P1 Down", "P1 Up", "P2 Right", "P2 Left", "P2 Down", "P2 Up"],
    note: "One fire button per player. Active-low everywhere.",
    faceButtons: FACE_BUTTON_MAP.atari2600,
  },
  c64: {
    register: "$DC00 (CIA1 PRA, port 2) and $DC01 (PRB, port 1)",
    protocol: "direct-read",
    strobe: "None.",
    readSequence: "Bits 0-4 are Up/Down/Left/Right/Fire, active-low.",
    bitOrder: ["Up", "Down", "Left", "Right", "Fire"],
    faceButtons: FACE_BUTTON_MAP.c64,
  },
  sms: {
    register: "I/O port $DC (controllers, read via `in a,($DC)`) and $DD (port 2 high bits + reset)",
    protocol: "direct-read",
    strobe: "None — the SMS reads controller bits directly from the Z80 I/O port.",
    readSequence: "$DC: bit0 P1 Up, bit1 P1 Down, bit2 P1 Left, bit3 P1 Right, bit4 P1 button 1 (TL), bit5 P1 button 2 (TR), bits6-7 P2 Up/Down. $DD: bits0-3 P2 Left/Right/TL/TR, bit6 reset. ALL ACTIVE-LOW (0 = pressed).",
    bitOrder: ["P1 Up", "P1 Down", "P1 Left", "P1 Right", "P1 Button1", "P1 Button2", "P2 Up", "P2 Down"],
    note: "Active-low: a pressed button reads 0. Two face buttons per pad (1=TL, 2=TR); no Start on the SMS pad (the console has a physical Pause button wired to the Z80 NMI). libretro JOYPAD maps button 1 → 'a', button 2 → 'b'.",
    faceButtons: FACE_BUTTON_MAP.sms,
  },
  gg: {
    register: "I/O port $DC (D-pad + buttons 1/2) and $00 (START button, bit 7)",
    protocol: "direct-read",
    strobe: "None — same VDP/controller chip as the SMS, read directly from Z80 I/O.",
    readSequence: "$DC: bit0 Up, bit1 Down, bit2 Left, bit3 Right, bit4 button 1, bit5 button 2 — all active-low. The Game Gear's extra START button is bit 7 of port $00 (also active-low).",
    bitOrder: ["Up", "Down", "Left", "Right", "Button1", "Button2"],
    note: "Active-low. Handheld single controller. START is at port $00 bit 7, NOT in $DC. libretro JOYPAD maps button 1 → 'a', button 2 → 'b', START → 'start'.",
    faceButtons: FACE_BUTTON_MAP.gg,
  },
};

const LIBRETRO_JOYPAD_IDS = {
  b: 0, y: 1, select: 2, start: 3,
  up: 4, down: 5, left: 6, right: 7,
  a: 8, x: 9, l: 10, r: 11,
  l2: 12, r2: 13, l3: 14, r3: 15,
};

// Per-platform mapping from button name → hardware register bit position
// (as it appears in the ROM-readable joypad register, NOT libretro's id).
// SNES read of $4218 returns a 16-bit value: button = (val & bit) != 0.
// NES read of $4016 returns 8 sequential bits: each `lda $4016 ; lsr a ;
// rol keydown` extracts one — bit-position here = byte position in that
// keydown register after 8 shifts.
//
// These are the bits a ROM ACTUALLY reads. The libretro JOYPAD ids above
// are protocol ids for setInput, NOT hardware bit positions. Confusing
// the two is the bug from devnote.md #7.
const HARDWARE_BITS = {
  nes: { // 8-bit shift register; bit positions in the 8-bit keydown byte
    a: 0x80, b: 0x40, select: 0x20, start: 0x10,
    up: 0x08, down: 0x04, left: 0x02, right: 0x01,
  },
  snes: { // 16-bit auto-read at $4218
    b: 0x8000, y: 0x4000, select: 0x2000, start: 0x1000,
    up: 0x0800, down: 0x0400, left: 0x0200, right: 0x0100,
    a: 0x0080, x: 0x0040, l: 0x0020, r: 0x0010,
  },
  gb: { // $FF00 P1 register, active-low — bits 0-3
    // Note: row-select dependent. These are the bits READ when each row is selected.
    a: 0x01, b: 0x02, select: 0x04, start: 0x08,        // buttons row (bit 5 low)
    right: 0x01, left: 0x02, up: 0x04, down: 0x08,      // directions row (bit 4 low)
  },
  gbc: { // Same as gb
    a: 0x01, b: 0x02, select: 0x04, start: 0x08,
    right: 0x01, left: 0x02, up: 0x04, down: 0x08,
  },
  genesis: { // $A10003 — bit positions depend on TH state
    // TH=1 reads: bit 0=Up, 1=Down, 2=Left, 3=Right, 4=B, 5=C
    up: 0x01, down: 0x02, left: 0x04, right: 0x08, b: 0x10, c: 0x20,
    // TH=0 reads: bit 4=A, 5=Start
    a: 0x10, start: 0x20,
  },
  c64: { // CIA1 PRB ($DC01), active-low — bits 0-4
    up: 0x01, down: 0x02, left: 0x04, right: 0x08, fire: 0x10,
  },
  atari2600: { // SWCHA ($280) high nibble = P1; INPT4 ($28C) bit 7 = P1 fire
    up: 0x10, down: 0x20, left: 0x40, right: 0x80, // SWCHA bits
    fire: 0x80, // INPT4 bit 7
  },
};

// Which physical buttons each platform actually has. The setInput surface
// accepts the full Xbox-shaped set, but pressing buttons that aren't wired
// on a platform is a silent no-op. This map lets the agent ask "what's real
// here" instead of probing.
const PHYSICAL_BUTTONS = {
  // dpad and start/select are universal on platforms that have any input at all
  nes:       ["up", "down", "left", "right", "east", "west", "start", "select"],
  gb:        ["up", "down", "left", "right", "east", "west", "start", "select"],
  gbc:       ["up", "down", "left", "right", "east", "west", "start", "select"],
  sms:       ["up", "down", "left", "right", "east", "west", "start"],
  gg:        ["up", "down", "left", "right", "east", "west", "start"],
  snes:      ["up", "down", "left", "right", "north", "east", "south", "west", "l", "r", "start", "select"],
  genesis:   ["up", "down", "left", "right", "east", "south", "west", "start"], // 3-button; 6-button adds north + l/r-like Z/X
  gba:       ["up", "down", "left", "right", "east", "south", "l", "r", "start", "select"],
  atari2600: ["up", "down", "left", "right", "south"],
  atari7800: ["up", "down", "left", "right", "east", "south", "start", "select"],
  lynx:      ["up", "down", "left", "right", "east", "south", "start"],
  c64:       ["up", "down", "left", "right", "south"],
};

export function registerInputLayoutTools(server, z) {
  server.tool(
    "getInputLayout",
    "Return the platform's hardware input register format, button bit ordering, libretro id mapping, and the set of buttons that are physically present on this platform. Use this BEFORE writing input-reading asm code OR before deciding what controls your game will use — saves you from probing empirically AND from binding to a button that doesn't exist on the target platform.",
    {
      platform: z.string().describe("Platform id (nes, gb, gbc, snes, genesis, atari2600, c64, ...)."),
    },
    safeTool(async ({ platform }) => {
      const layout = HARDWARE_LAYOUTS[platform];
      if (!layout) {
        throw new Error(`no input layout documented for platform '${platform}'. Supported: ${Object.keys(HARDWARE_LAYOUTS).join(", ")}`);
      }
      return jsonContent({
        platform,
        ...layout,
        physicalButtons: PHYSICAL_BUTTONS[platform] ?? [],
        controllerModel: "romdev uses an Xbox-shaped baseline for setInput: dpad + 4 face buttons (north/east/south/west) + l/r/l2/r2 + l3/r3 sticks + start/select. Older platforms are subsets — physicalButtons lists what's actually wired. Pressing a button not in that list is a silent no-op.",
        libretroJoypadIds: LIBRETRO_JOYPAD_IDS,
        hardwareBits: HARDWARE_BITS[platform] ?? null,
        hardwareBitsCaveat:
          "libretroJoypadIds are PROTOCOL ids for the setInput MCP tool; they are NOT the bit positions a ROM reads from the hardware register. " +
          "hardwareBits gives the actual register bits a ROM tests (e.g. SNES: `lda $4218 ; bit #$1000` for start). " +
          "Confusing the two silently breaks input handling — verified by the rom-games agent's 30-min bisection that prompted this field.",
        note2: "Names from libretroJoypadIds work universally. Spatial face-button names (north/east/south/west) translate to the right physical button per platform — east is A on NES/SNES, C on Genesis. Prefer spatial names in cross-platform code.",
      });
    }),
  );
}
