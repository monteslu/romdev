// Game Gear (SN76489 PSG) song compiler — a simple note/duration song → the
// music_note_t table the bundled driver (lib/c/gg_music.c + gg_music.h) plays.
//
// This is NOT a port of an external tool: there's no single canonical Game Gear
// "song compiler" — the playable format is whatever OUR driver reads. gg_music's
// engine walks an array of `music_note_t` rows, one per note, advancing one note
// per call to music_update() (once per 60 Hz frame). Each row is:
//
//   typedef struct {
//     uint16_t note;   // SN76489 10-bit freq divider, or 0 for rest
//     uint8_t  dur;    // duration in frames (60 Hz); 0 = end-of-song
//   } music_note_t;     // packed as 3 bytes here: note_lo, note_hi, dur
//
//   ...rows...
//   { 0, 0 }            // end-of-song sentinel (note 0 AND dur 0)
//
// A "note" is a pre-baked SN76489 tone-register divider, NOT Hz. The chip latches
// this 10-bit value into the divide-by-N counter of one tone channel; the output
// frequency is  PSG_CLOCK / (32 * divider). So to author a note we invert that:
//
//   divider = round( 3579545 / (32 * freq_hz) )     // NTSC PSG clock 3.579545 MHz
//
// (3579545 / 32 = 111860.78 — the chip's max tone update rate.) Higher divider =
// LOWER pitch. The divider is 10-bit, so valid range is 1..1023; 0 means rest
// (the engine silences the channel). divider==1 is the highest tone the chip can
// make (~111.86 kHz, inaudible); musically useful values sit in ~107..1023.
//
// Input: a compact song — an array of {note, dur} (or shorthand strings). The note
// is a scientific-pitch name ("C4", "A#3", "G-5") or a raw divider ({div: 254}).
// We resolve names to Hz via equal temperament around A4=440 (configurable), then
// to a divider via the formula above. Output: the 3-byte-per-row table + the
// {0,0} sentinel, either as raw bytes or as a C `music_note_t[]` block to drop
// straight into gg_music.c.

/** Semitone index within an octave for each note letter (C=0). */
const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** NTSC SN76489 PSG clock in Hz (Game Gear / SMS). */
export const PSG_CLOCK = 3579545;

/** Tone divider is 10 bits on the SN76489. */
const DIVIDER_MAX = 0x3ff; // 1023

/**
 * Parse a scientific-pitch note name ("C4", "A#3", "Gb5", "C-4") to an absolute
 * semitone number where C0 = 0, C4 = 48 (so A4 = 57). Copied from the SNES song
 * compiler so the two files stay independent.
 * @param {string} name
 * @returns {number} absolute semitone index
 */
export function noteToSemitone(name) {
  const m = /^([A-Ga-g])([#b-]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`GG song: bad note name "${name}" (expected like "C4", "A#3", "Gb5").`);
  const letter = m[1].toUpperCase();
  let semi = NOTE_BASE[letter];
  if (m[2] === '#') semi += 1;
  else if (m[2] === 'b') semi -= 1;
  // '-' is just a separator (FamiTracker-style "C-4"), no accidental.
  const octave = parseInt(m[3], 10);
  return octave * 12 + semi;
}

/**
 * Equal-temperament frequency (Hz) for an absolute semitone, tuned so that
 * `a4Semi` (default A4 = semitone 57) sounds at `a4Hz` (default 440).
 * @param {number} semi   absolute semitone index (C0 = 0)
 * @param {number} [a4Hz=440]
 * @param {number} [a4Semi]  absolute semitone of the A4 reference (default 57)
 * @returns {number} frequency in Hz
 */
export function semitoneToHz(semi, a4Hz = 440, a4Semi = noteToSemitone('A4')) {
  return a4Hz * Math.pow(2, (semi - a4Semi) / 12);
}

/**
 * SN76489 tone divider for a frequency.
 *   divider = round( PSG_CLOCK / (32 * freq_hz) )
 * Clamped to the chip's 10-bit range (1..1023). This is the exact formula the
 * driver header documents and its NOTE_* table was baked with.
 * @param {number} hz   frequency in Hz
 * @param {number} [clock=PSG_CLOCK]
 * @returns {number} 10-bit divider value
 */
export function hzToDivider(hz, clock = PSG_CLOCK) {
  if (!(hz > 0)) throw new Error(`GG song: frequency must be > 0 (got ${hz}).`);
  const d = Math.round(clock / (32 * hz));
  return Math.max(1, Math.min(DIVIDER_MAX, d));
}

/**
 * Convenience: scientific-pitch note name → SN76489 divider.
 * @param {string} name  e.g. "A4"
 * @param {object} [opts]
 * @param {number} [opts.a4Hz=440]
 * @param {number} [opts.clock=PSG_CLOCK]
 * @returns {number} 10-bit divider value
 */
export function noteToDivider(name, opts = {}) {
  const semi = noteToSemitone(name);
  const hz = semitoneToHz(semi, opts.a4Hz ?? 440);
  return hzToDivider(hz, opts.clock ?? PSG_CLOCK);
}

/**
 * Compile a song to the gg_music music_note_t row table.
 *
 * @param {object} song
 * @param {Array<{note?:string, div?:number, dur?:number, ticks?:number}|string>} song.rows
 *   One entry per note. `{note:"C4", dur:18}` resolves the divider from the name;
 *   `{div:254, dur:18}` uses a raw 10-bit divider. A bare string "C4" or "C4:18"
 *   is shorthand (default duration from `song.defaultDur`). A `null`/`"rest"`
 *   entry (or `{note:"rest"}`) emits divider 0 — the engine silences the channel
 *   for that row's duration, which is a true musical rest on this driver.
 * @param {number} [song.a4Hz=440]  concert-A reference for equal temperament.
 * @param {number} [song.clock=PSG_CLOCK]  PSG clock (Hz); NTSC GG/SMS = 3579545.
 * @param {number} [song.defaultDur=18]  duration (frames) for shorthand entries.
 * @param {string} [song.name="song0"]   C array identifier in the emitted snippet.
 * @returns {{ bytes: Uint8Array, rows: number, cSource: string, asm: string }}
 *   bytes = the raw table (3 bytes/row: note_lo, note_hi, dur) + a {0,0} sentinel
 *   (3 trailing zero bytes). cSource = a `music_note_t[]` C block. `asm` is an
 *   alias of `cSource` so callers expecting the SNES `.asm` field still work.
 */
export function compileSong(song) {
  if (!song || !Array.isArray(song.rows)) {
    throw new Error('GG song: expected { rows: [...] }.');
  }
  const a4Hz = song.a4Hz ?? 440;
  const clock = song.clock ?? PSG_CLOCK;
  const defaultDur = song.defaultDur ?? 18;
  const arrName = song.name ?? 'song0';

  const out = [];
  const cRows = [];

  for (const raw of song.rows) {
    let note, div, dur;
    if (typeof raw === 'string') {
      // "C4" or "C4:18"
      const [n, d] = raw.split(':');
      note = n;
      dur = d != null ? parseInt(d, 10) : defaultDur;
    } else {
      note = raw.note;
      div = raw.div;
      // accept `ticks` as a synonym for `dur` so SNES-shaped songs reuse cleanly
      dur = raw.dur ?? raw.ticks ?? defaultDur;
    }
    if (!Number.isInteger(dur) || dur < 1 || dur > 255) {
      throw new Error(`GG song: dur ${dur} out of range 1..255.`);
    }

    let label;
    if (div == null) {
      if (note == null || note === 'rest' || note === null) {
        div = 0; // true rest — driver silences the channel
        label = 'rest';
      } else {
        div = noteToDivider(note, { a4Hz, clock });
        label = note;
      }
    } else {
      label = `div=${div}`;
    }
    if (!Number.isInteger(div) || div < 0 || div > DIVIDER_MAX) {
      throw new Error(`GG song: divider ${div} out of 10-bit range 0..${DIVIDER_MAX}.`);
    }

    const lo = div & 0xff;
    const hi = (div >> 8) & 0xff; // top 2 bits of the 10-bit divider
    out.push(lo, hi, dur & 0xff);
    cRows.push(`  { ${String(div).padStart(4, ' ')}, ${String(dur).padStart(3, ' ')} },  /* ${label} */`);
  }

  // End-of-song sentinel {0, 0}: note 0 AND dur 0. Packed as 3 zero bytes.
  out.push(0x00, 0x00, 0x00);
  cRows.push('  { 0, 0 },  /* end-of-song sentinel */');

  const cSource =
    `static const music_note_t ${arrName}[] = {\n${cRows.join('\n')}\n};\n`;

  return {
    bytes: new Uint8Array(out),
    rows: song.rows.length,
    cSource,
    asm: cSource, // alias for parity with the SNES compiler's { asm } shape
  };
}

export default compileSong;
