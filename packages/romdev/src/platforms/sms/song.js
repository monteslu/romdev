// SMS song compiler — note/duration → the parallel-array music table that the
// bundled SN76489 PSG driver (lib/c/sms_music.c) plays back on voice 0.
//
// This is NOT a port of an external tool: there is no single canonical "SMS song
// compiler" — the playable format is whatever OUR driver reads. Unlike the SNES
// driver (interleaved 3-byte rows + $00 terminator) and unlike the GG driver
// (a `music_note_t {note,dur}` struct array + a {0,0} sentinel), sms_music.c
// uses TWO PARALLEL FIXED-LENGTH ARRAYS per voice and NO sentinel:
//
//   static const uint16_t mel0_freq[N] = { D_E5, D_D5, ... };   // 10-bit dividers
//   static const uint8_t  mel0_len[N]  = { Q, Q, ... };          // frames per step
//
// The driver knows each track's length from a separate `track_len[3]` lookup
// (track_len[0] = N for the melody voice) and loops by wrapping the step cursor
// at that length — there is no end byte. A divider of 0 (D_REST) means "rest":
// the driver silences the channel and just counts down the duration.
//
// SN76489 frequency divider math (NTSC SMS, 3.579545 MHz / 32):
//   Hz = 3579545 / 32 / divider     →    divider = round(3579545 / (32 * Hz))
//   A4 (440 Hz) → 254, C4 (261.63 Hz) → 428, C3 (130.81 Hz) → 855.
// The divider register is 10 bits wide (0x000..0x3FF), so values are clamped.
//
// Input: a compact song — an array of {note, frames} (or shorthand strings). The
// note is a scientific-pitch name ("C4", "A#3", "G-5"), the literal "rest"/null,
// or a raw divider ({divider: 254}). Output mirrors snes/song.js:
//   compileSong(song) -> { bytes: Uint8Array, cSource: string, rows: number, ... }
// `bytes` is the freq array (2 bytes/row, little-endian) followed by the len
// array (1 byte/row) — exactly the in-ROM byte image of the two const arrays for
// a single voice. `cSource` is a drop-in replacement for one voice's mel*_freq /
// mel*_len pair in sms_music.c.

/** SN76489 / SMS master clock used for the divider (NTSC). */
export const SMS_PSG_CLOCK = 3579545;

/** PSG tone divider register width: 10 bits (0x000..0x3FF). */
export const PSG_DIVIDER_MAX = 0x3ff;

/** Divider value the driver treats as a rest (D_REST). */
export const REST_DIVIDER = 0;

/** Semitone index within an octave for each note letter (C=0). */
const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Parse a scientific-pitch note name ("C4", "A#3", "Gb5", "C-4") to an absolute
 * semitone number where C0 = 0, C4 = 48 (so A4 = 57).
 * (Same logic as snes/song.js — copied so the two files stay independent.)
 * @param {string} name
 * @returns {number} absolute semitone index
 */
export function noteToSemitone(name) {
  const m = /^([A-Ga-g])([#b-]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`SMS song: bad note name "${name}" (expected like "C4", "A#3", "Gb5").`);
  const letter = m[1].toUpperCase();
  let semi = NOTE_BASE[letter];
  if (m[2] === '#') semi += 1;
  else if (m[2] === 'b') semi -= 1;
  // '-' is just a separator (FamiTracker-style "C-4"), no accidental.
  const octave = parseInt(m[3], 10);
  return octave * 12 + semi;
}

/**
 * Frequency in Hz for an absolute semitone, equal temperament tuned to A4=440.
 * A4 = semitone 57 (octave 4 * 12 + 9).
 * @param {number} semi  absolute semitone (C0=0)
 * @returns {number} frequency in Hz
 */
export function semitoneToHz(semi) {
  return 440 * Math.pow(2, (semi - 57) / 12);
}

/**
 * SN76489 tone divider for a frequency.
 *   divider = round(SMS_PSG_CLOCK / (32 * Hz)), clamped to the 10-bit register.
 * @param {number} hz  frequency in Hz (must be > 0)
 * @returns {number} 10-bit tone divider (1..0x3FF)
 */
export function hzToDivider(hz) {
  if (!(hz > 0)) throw new Error(`SMS song: frequency ${hz} must be > 0 Hz.`);
  const d = Math.round(SMS_PSG_CLOCK / (32 * hz));
  return Math.max(1, Math.min(PSG_DIVIDER_MAX, d));
}

/**
 * SN76489 tone divider for a scientific-pitch note name.
 * @param {string} name  e.g. "A4"
 * @returns {number} 10-bit tone divider
 */
export function noteToDivider(name) {
  return hzToDivider(semitoneToHz(noteToSemitone(name)));
}

/**
 * Resolve one row to { divider, frames, label }.
 * @param {object|string} raw
 * @param {number} defaultFrames
 * @returns {{divider:number, frames:number, label:string}}
 */
function resolveRow(raw, defaultFrames) {
  let note, divider, frames;
  if (typeof raw === 'string') {
    // "A4" or "A4:18" or "rest:12"
    const [n, t] = raw.split(':');
    note = n;
    frames = t != null ? parseInt(t, 10) : defaultFrames;
  } else if (raw == null) {
    note = 'rest';
    frames = defaultFrames;
  } else {
    note = raw.note;
    divider = raw.divider;
    frames = raw.frames ?? raw.dur ?? raw.ticks ?? defaultFrames;
  }

  if (!Number.isInteger(frames) || frames < 1 || frames > 255) {
    throw new Error(`SMS song: frames ${frames} out of range 1..255 (uint8 duration).`);
  }

  let label;
  if (divider == null) {
    if (note == null || note === 'rest' || note === 'R' || note === '---') {
      divider = REST_DIVIDER;
      label = 'rest';
    } else {
      divider = noteToDivider(note);
      label = note;
    }
  } else {
    if (!Number.isInteger(divider) || divider < 0 || divider > PSG_DIVIDER_MAX) {
      throw new Error(`SMS song: divider ${divider} out of 10-bit range 0..${PSG_DIVIDER_MAX}.`);
    }
    label = divider === 0 ? 'rest' : `div=${divider}`;
  }

  return { divider, frames, label };
}

/**
 * Compile a song to the sms_music.c parallel-array voice table.
 *
 * @param {object} song
 * @param {Array<{note?:string, divider?:number, frames?:number}|string|null>} song.rows
 *   One entry per step on this voice. `{note:"A4", frames:18}` resolves the
 *   divider from the name; `{divider:254, frames:18}` uses a raw 10-bit divider;
 *   a bare string "A4" or "A4:18" is shorthand (frames default to
 *   `song.defaultFrames`); `null`, `"rest"`, `{note:"rest"}` emit a rest
 *   (divider 0, channel silenced for `frames`).
 * @param {number} [song.defaultFrames=18]  frames for entries without a duration
 *   (driver runs at 60 fps; quarter ≈ 18, half ≈ 36, eighth ≈ 9).
 * @param {number} [song.voice=0]  which voice this table is for (0..2); only
 *   affects the emitted C identifier names (mel0_/mel1_/mel2_).
 * @param {string} [song.name]  base name for the emitted C arrays; defaults to
 *   `mel${voice}` to match sms_music.c.
 * @returns {{ bytes: Uint8Array, freq: Uint16Array, len: Uint8Array, rows: number, cSource: string }}
 *   `bytes` = freq array (2 bytes/row LE) then len array (1 byte/row) — the raw
 *   in-ROM image. `freq`/`len` are the typed arrays the driver declares.
 *   `cSource` = a drop-in `static const uint16_t NAME_freq[N]` + `uint8_t
 *   NAME_len[N]` pair (and the matching track_len[voice] count).
 */
export function compileSong(song) {
  if (!song || !Array.isArray(song.rows)) {
    throw new Error('SMS song: expected { rows: [...] }.');
  }
  if (song.rows.length < 1 || song.rows.length > 255) {
    throw new Error(`SMS song: row count ${song.rows.length} out of range 1..255 (track_len is uint8).`);
  }
  const defaultFrames = song.defaultFrames ?? 18;
  const voice = song.voice ?? 0;
  const name = song.name ?? `mel${voice}`;

  const n = song.rows.length;
  const freq = new Uint16Array(n);
  const len = new Uint8Array(n);
  const labels = [];

  for (let i = 0; i < n; i++) {
    const { divider, frames, label } = resolveRow(song.rows[i], defaultFrames);
    freq[i] = divider & 0xffff;
    len[i] = frames & 0xff;
    labels.push(label);
  }

  // Raw in-ROM byte image: freq[] (uint16 LE) followed by len[] (uint8).
  const bytes = new Uint8Array(n * 2 + n);
  for (let i = 0; i < n; i++) {
    bytes[i * 2] = freq[i] & 0xff;
    bytes[i * 2 + 1] = (freq[i] >> 8) & 0xff;
  }
  for (let i = 0; i < n; i++) bytes[n * 2 + i] = len[i];

  // Emit C matching sms_music.c's declaration shape exactly.
  const freqItems = [];
  const lenItems = [];
  for (let i = 0; i < n; i++) {
    freqItems.push(`${freq[i]}`);
    lenItems.push(`${len[i]}`);
  }
  // 8 per line to echo the driver's hand-authored layout.
  const wrap = (items, indent) => {
    const lines = [];
    for (let i = 0; i < items.length; i += 8) {
      lines.push(indent + items.slice(i, i + 8).join(', ') + ',');
    }
    return lines.join('\n');
  };

  const cSource =
    `/* Voice ${voice}: ${n} steps. divider 0 = rest. */\n` +
    `static const uint16_t ${name}_freq[${n}] = {\n${wrap(freqItems, '  ')}\n};\n` +
    `static const uint8_t  ${name}_len[${n}] = {\n${wrap(lenItems, '  ')}\n};\n` +
    `/* set track_len[${voice}] = ${n}; */\n`;

  return { bytes, freq, len, rows: n, cSource };
}

export default compileSong;
