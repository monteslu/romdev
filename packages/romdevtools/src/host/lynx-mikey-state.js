// Atari Lynx (Mikey chip) state introspection.
//
// Same idea as nes-apu-state.js / gb-apu-state.js: give Lynx music and
// graphics jobs a "what is each channel playing / what palette is loaded /
// where is the display pointed this frame?" decode straight off the hardware
// register file, independent of whatever private driver the game uses.
//
// Data source: the `lynx_hw_regs` region — the 512-byte Lynx hardware window
// at $FC00-$FDFF. Byte offset `i` in the array == Lynx address $FC00 + i, so
// the Mikey registers ($FD00-$FDFF) live in the second half, offsets
// 0x100-0x1FF. (Suzy is the first half, $FC00-$FCFF; we don't decode it here.)
//
// Mikey owns audio, the palette, and the display controller:
//
//   Audio ch N base = 0x120 + N*8   (ch0=$FD20, ch1=$FD28, ch2=$FD30, ch3=$FD38)
//     +0 VOLUME    signed 8-bit               $FD20
//     +1 FEEDBACK  shift-register feedback taps $FD21
//     +2 OUTPUT    current output value        $FD22
//     +3 SHIFT     low 8 bits of the 12-bit LFSR $FD23
//     +4 BACKUP    timer reload/period (pitch) $FD24
//     +5 CONTROL   clock select + enable bits  $FD25
//     +6 COUNTER   current timer value         $FD26
//     +7 OTHER     bits 4-7 = high nibble of 12-bit LFSR; bits 0-3 misc $FD27
//   MPAN    $FD44 (offset 0x144) per-channel pan
//   MSTEREO $FD50 (offset 0x150) per-channel L/R enable (STEREO)
//   Palette green nibbles $FDA0-$FDAF (offset 0x1A0-0x1AF): low nibble = green4
//   Palette blue+red      $FDB0-$FDBF (offset 0x1B0-0x1BF): hi nibble = blue4,
//                                                            lo nibble = red4
//   DISPCTL $FD92 (offset 0x192) display control flags
//   DISPADR $FD94-$FD95 (offset 0x194, 16-bit LE) display DMA base address
//
// These are the *register* bytes (what the CPU last wrote / what Mikey holds),
// which is exactly the pitch/volume/colour/display layer you want for music
// transcription and visual debugging without reverse-engineering the game's
// private driver.

import { freqToNote } from "./gb-apu-state.js";

// Mikey audio register block: 4 channels, 8 bytes apart, starting at $FD20.
const AUDIO_BASE = 0x120;
const AUDIO_STRIDE = 0x08;

// CONTROL low 3 bits select the timer's clock source. Each tick is this many
// microseconds; index 7 = "link" (clocked by the previous timer's underflow),
// for which we can't derive an absolute frequency.
const US_PER_TICK = [1, 2, 4, 8, 16, 32, 64];

// Palette register offsets within the 512-byte `lynx_hw_regs` window.
const PAL_GREEN = 0x1a0; // $FDA0-$FDAF: low nibble = 4-bit green
const PAL_BLUERED = 0x1b0; // $FDB0-$FDBF: hi nibble = blue, lo nibble = red

// Display controller register offsets.
const DISPCTL = 0x192; // $FD92
const DISPADR = 0x194; // $FD94-$FD95 (16-bit LE)

// Pan / stereo register offsets.
const MPAN = 0x144; // $FD44
const MSTEREO = 0x150; // $FD50

/** Format a byte as a "0x.." hex string (2 digits). */
function hex(b) {
  return "0x" + (b & 0xff).toString(16).padStart(2, "0");
}

/** Format a 16-bit value as a "0x...." hex string (4 digits). */
function hex16(v) {
  return "0x" + (v & 0xffff).toString(16).padStart(4, "0");
}

/** Round a frequency to 2 decimal places (null stays null). */
function round2(hz) {
  return hz == null ? null : Math.round(hz * 100) / 100;
}

/** Interpret a byte as a signed 8-bit value (-128..127). */
function signed8(b) {
  return (b & 0x80) ? (b & 0xff) - 256 : (b & 0xff);
}

/** Expand a 4-bit value (0-15) to 8-bit, replicating the nibble (0xF -> 0xFF). */
function expand4(v) {
  return ((v & 0x0f) << 4) | (v & 0x0f);
}

/**
 * @typedef {{
 *   volume: number, freqHz: number|null, note: string|null, enabled: boolean,
 *   clockSelect: number, backup: number, integrate: boolean, feedback: number,
 *   shiftRegister: number, output: number
 * }} LynxAudioChannel
 */

/**
 * Decode the Lynx Mikey audio register file into per-channel musical state.
 *
 * Frequency is approximate: the channel timer is clocked every `usPerTick`
 * microseconds (selected by CONTROL bits 0-2) and the audio output toggles
 * every (BACKUP+1) ticks, so a full waveform cycle takes two toggles:
 *   freqHz = 1e6 / ((BACKUP + 1) * usPerTick * 2)
 * usPerTick = [1,2,4,8,16,32,64][clockSelect] for clockSelect 0-6;
 * clockSelect 7 = "link" (timer chained to another) -> freqHz reported null.
 * This ignores the LFSR/integrate modes, so treat it as a pitch estimate and
 * cross-check with recordAudio when a channel looks ambiguous.
 *
 * @param {Uint8Array} hw the 512-byte `lynx_hw_regs` region ($FC00-$FDFF)
 * @returns {{
 *   channels: LynxAudioChannel[],
 *   stereo: string,
 *   pan: string,
 * }}
 */
export function decodeLynxMikey(hw) {
  const channels = [];
  for (let n = 0; n < 4; n++) {
    const base = AUDIO_BASE + n * AUDIO_STRIDE;
    const volume = signed8(hw[base + 0]); // +0 VOLUME (signed)
    const feedback = hw[base + 1]; // +1 FEEDBACK
    const output = signed8(hw[base + 2]); // +2 OUTPUT (signed sample value)
    const shift = hw[base + 3]; // +3 SHIFT (low 8 bits of LFSR)
    const backup = hw[base + 4]; // +4 BACKUP (timer period)
    const control = hw[base + 5]; // +5 CONTROL
    const other = hw[base + 7]; // +7 OTHER (hi nibble of LFSR in bits 4-7)

    const clockSelect = control & 0x07; // bits 0-2: clock source select
    const enabled = !!(control & 0x10); // bit 4: enable-count
    const integrate = !!(control & 0x20); // bit 5: integrate mode

    // Frequency only means something when the channel is actually counting
    // (enable-count set). A disabled channel — or clockSelect 7 "link" — has no
    // standalone tone, so report null rather than a bogus ultrasonic value (a
    // disabled channel commonly reads backup=0 → a meaningless 500 kHz).
    const usPerTick = clockSelect < 7 ? US_PER_TICK[clockSelect] : null;
    const freqHz =
      (enabled && usPerTick != null) ? 1e6 / ((backup + 1) * usPerTick * 2) : null;

    // 12-bit LFSR state: low 8 bits in SHIFT, high 4 bits in OTHER bits 4-7.
    const shiftRegister = shift | ((other & 0xf0) << 4);

    channels.push({
      volume,
      freqHz: round2(freqHz),
      note: freqToNote(freqHz),
      enabled,
      clockSelect,
      backup,
      integrate,
      feedback,
      shiftRegister,
      output,
    });
  }

  return {
    channels,
    stereo: hex(hw[MSTEREO]), // $FD50 MSTEREO: per-channel L/R enable bits
    pan: hex(hw[MPAN]), // $FD44 MPAN: per-channel pan
  };
}

/**
 * @typedef {{
 *   index: number, r: number, g: number, b: number, hex: string,
 *   green4: number, red4: number, blue4: number
 * }} LynxPaletteEntry
 */

/**
 * Decode the Lynx Mikey 16-entry palette into 8-bit RGB.
 *
 * Each colour is 12-bit (4 bits per component), split across two register
 * banks: green nibbles at $FDA0-$FDAF, blue+red at $FDB0-$FDBF. We expand each
 * 4-bit component to 8-bit by nibble replication (0xF -> 0xFF) so `hex` is a
 * directly usable "#rrggbb" web colour.
 *
 * @param {Uint8Array} hw the 512-byte `lynx_hw_regs` region ($FC00-$FDFF)
 * @returns {{ entries: LynxPaletteEntry[] }}
 */
export function decodeLynxPalette(hw) {
  const entries = [];
  for (let i = 0; i < 16; i++) {
    const green4 = hw[PAL_GREEN + i] & 0x0f; // low nibble = green
    const blueRed = hw[PAL_BLUERED + i];
    const blue4 = (blueRed >> 4) & 0x0f; // hi nibble = blue
    const red4 = blueRed & 0x0f; // lo nibble = red
    const r = expand4(red4);
    const g = expand4(green4);
    const b = expand4(blue4);
    const hx =
      "#" +
      r.toString(16).padStart(2, "0") +
      g.toString(16).padStart(2, "0") +
      b.toString(16).padStart(2, "0");
    entries.push({ index: i, r, g, b, hex: hx, green4, red4, blue4 });
  }
  return { entries };
}

/**
 * Decode the Lynx Mikey display controller (DISPCTL + DISPADR).
 *
 * DISPCTL ($FD92) bits: bit0 = display DMA enable, bit1 = flip (left-handed
 * mode / vertical flip), bit3 = 4-colour mode (vs the default 4 bits-per-pixel
 * 16-colour mode). DISPADR ($FD94-$FD95, 16-bit LE) is the display DMA base
 * address — where Mikey reads the framebuffer from.
 *
 * @param {Uint8Array} hw the 512-byte `lynx_hw_regs` region ($FC00-$FDFF)
 * @returns {{
 *   dispctl: string, displayDmaEnable: boolean, flip: boolean,
 *   fourColour: boolean, displayAddress: string, note: string,
 * }}
 */
export function decodeLynxRenderingContext(hw) {
  const dispctl = hw[DISPCTL];
  const displayAddress = hw[DISPADR] | (hw[DISPADR + 1] << 8);
  return {
    dispctl: hex(dispctl),
    displayDmaEnable: !!(dispctl & 0x01), // bit0: display DMA enable
    flip: !!(dispctl & 0x02), // bit1: flip
    fourColour: !!(dispctl & 0x08), // bit3: 4-colour mode (else 16-colour 4bpp)
    displayAddress: hex16(displayAddress),
    note:
      "DISPCTL ($FD92) + DISPADR ($FD94). displayDmaEnable off means Mikey " +
      "isn't scanning out a framebuffer (blank screen). displayAddress is the " +
      "DMA base Mikey reads pixels from each frame.",
  };
}
