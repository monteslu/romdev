// C64 song compiler — note/duration song → the exact (freq, length_frames)
// tables the bundled SID driver plays.
//
// This is NOT a .sid file or a port of an external tool. The C64 has no single
// canonical "song compiler"; the playable format is whatever OUR driver reads.
// The bundled driver is lib/c/c64_music.c + c64_music.h: a plain per-frame
// 3-voice sequencer. Each voice walks an independent, parallel array of
// (freq, length_frames) pairs and writes SID registers on note transitions.
//
// Driver contract (read from c64_music.c / c64_registers.h):
//
//   typedef struct { uint16_t freq; uint8_t len; } Note;   // len in frames
//   static const Note melody[];    // voice 0  (SID_VOICE 0)
//   static const Note bass[];      // voice 1  (SID_VOICE 1)
//   static const Note harmony[];   // voice 2  (SID_VOICE 2)
//
//   - On each note transition the driver writes:
//       SID_FREQ_LO(v) = freq & 0xFF
//       SID_FREQ_HI(v) = freq >> 8
//     then gate-off/gate-on to retrigger the ADSR envelope.
//   - freq == 0x0000 (N_REST) → the voice gates off WITHOUT retriggering
//     (the release tail plays); it is a real rest, not a held note.
//   - There is NO end-of-table sentinel byte. Each voice loops by WRAPPING
//     (v_pos >= voice_len → v_pos = 0). So a "song" is just the array length;
//     length is recovered in C via sizeof(arr)/sizeof(arr[0]).
//   - len is a single uint8_t (frames), valid 1..255. 0 would make the driver
//     advance every frame, so we reject it.
//   - music_update() is called once per VBlank (~50 Hz PAL / 60 Hz NTSC), so a
//     "frame" is one screen refresh. len = frames the note is held.
//
// Pitch math (the stated contract): SID 16-bit frequency divider word
//
//       freq = round(Hz / 0.0596)         (Hz ≈ freq * 0.0596)
//
// where Hz is standard equal-tempered scientific pitch with A4 = 440 Hz. We
// reuse the SNES compiler's note-name → absolute-semitone logic (copied here so
// the two files stay independent), map semitone → Hz, then Hz → SID divider.
//
//   A4 ("A4")  → 440 Hz       → round(440 / 0.0596)      = 7383 = 0x1CD7
//   C4 ("C4")  → 261.626 Hz   → round(261.626 / 0.0596)  = 4390 = 0x1126
//
// NOTE on the driver's hardcoded #define table: the demo tune in c64_music.c
// uses macros (N_A4 = 0x3CF1, ...) whose octave LABELS sit one octave above
// standard scientific pitch (its "A4" sounds at ~930 Hz ≈ a real A5). Those are
// the original author's labels for the bundled demo only. This compiler follows
// the documented, stated contract — round(Hz / 0.0596) with A4 = 440 — so a song
// row "A4" produces the SID word for a true 440 Hz A4 (0x1CD7). Bump every note
// up an octave in your song if you want to reproduce the demo's brighter
// register.
//
// Output: a byte table + a C snippet that drops straight into c64_music.c.
//   - bytes: per-voice, 3 bytes/note in SID write order [freq_lo, freq_hi, len],
//     voices concatenated in order [voice0..][voice1..][voice2..]. (The driver
//     stores Note as a 16-bit field + 8-bit field; this byte layout mirrors the
//     two SID register bytes it writes plus the frame length.)
//   - cSource: the three `static const Note melody/bass/harmony[]` arrays,
//     ready to paste over the demo tables in c64_music.c.

/** SID frequency constant: Hz ≈ freq * K, so freq = round(Hz / K). PAL clock. */
export const SID_FREQ_K = 0.0596;

/** A rest: the driver gates off without retriggering when freq == 0. */
export const N_REST = 0x0000;

/** Semitone index within an octave for each note letter (C=0). */
const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** The three voice array names the driver reads, in voice order. */
export const VOICE_NAMES = ['melody', 'bass', 'harmony'];

/**
 * Parse a scientific-pitch note name ("C4", "A#3", "Gb5", "C-4") to an absolute
 * semitone number where C0 = 0, C4 = 48 (so A4 = 57). Copied from the SNES
 * compiler so the two files stay independent.
 * @param {string} name
 * @returns {number} absolute semitone index
 */
export function noteToSemitone(name) {
  const m = /^([A-Ga-g])([#b-]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`C64 song: bad note name "${name}" (expected like "C4", "A#3", "Gb5").`);
  const letter = m[1].toUpperCase();
  let semi = NOTE_BASE[letter];
  if (m[2] === '#') semi += 1;
  else if (m[2] === 'b') semi -= 1;
  // '-' is just a separator (FamiTracker-style "C-4"), no accidental.
  const octave = parseInt(m[3], 10);
  return octave * 12 + semi;
}

/**
 * Convert an absolute semitone (C0 = 0, A4 = 57) to its equal-tempered
 * frequency in Hz, anchored at A4 = 440 Hz.
 * @param {number} absSemi  absolute semitone index
 * @returns {number} frequency in Hz
 */
export function semitoneToHz(absSemi) {
  // A4 is absolute semitone 4*12 + 9 = 57.
  return 440 * Math.pow(2, (absSemi - 57) / 12);
}

/**
 * Convert a frequency in Hz to the SID 16-bit divider word.
 *   freq = round(Hz / 0.0596), clamped to 16 bits (0..65535).
 * @param {number} hz
 * @returns {number} 16-bit SID frequency word
 */
export function hzToSidFreq(hz) {
  const f = Math.round(hz / SID_FREQ_K);
  return Math.max(0, Math.min(0xffff, f));
}

/**
 * Convenience: scientific-pitch note name → SID 16-bit divider word.
 * @param {string} name  e.g. "A4" → 0x1CD7 (440 Hz)
 * @returns {number} 16-bit SID frequency word
 */
export function noteToSidFreq(name) {
  return hzToSidFreq(semitoneToHz(noteToSemitone(name)));
}

/**
 * Normalize one song row to { freq, len, label }.
 *
 * A row may be:
 *   - a string: "C4" or "C4:30" (note[:lenFrames])  or "rest" / "rest:30"
 *   - an object: { note:"C4", frames:30 } | { rest:true, frames:30 }
 *                | { freq:0x1CD7, frames:30 }  (raw SID word)
 * @param {string|object} raw
 * @param {number} defaultFrames
 * @returns {{ freq:number, len:number, label:string }}
 */
function normalizeRow(raw, defaultFrames) {
  let note, freq, len, isRest = false;
  if (typeof raw === 'string') {
    const [n, t] = raw.split(':');
    note = n.trim();
    len = t != null ? parseInt(t, 10) : defaultFrames;
    if (/^rest$/i.test(note)) isRest = true;
  } else if (raw && typeof raw === 'object') {
    len = raw.frames ?? raw.ticks ?? defaultFrames; // accept SNES-style `ticks` too
    if (raw.rest) {
      isRest = true;
    } else if (raw.freq != null) {
      freq = raw.freq;
    } else {
      note = raw.note;
      if (note != null && /^rest$/i.test(String(note))) isRest = true;
    }
  } else {
    throw new Error(`C64 song: bad row ${JSON.stringify(raw)}.`);
  }

  if (!Number.isInteger(len) || len < 1 || len > 255) {
    throw new Error(`C64 song: note length ${len} frames out of range 1..255.`);
  }

  let label;
  if (isRest) {
    freq = N_REST;
    label = 'rest';
  } else if (freq != null) {
    if (!Number.isInteger(freq) || freq < 0 || freq > 0xffff) {
      throw new Error(`C64 song: raw freq ${freq} out of 16-bit range 0..65535.`);
    }
    label = `$${freq.toString(16).toUpperCase()}`;
  } else {
    if (note == null) throw new Error(`C64 song: row missing note/rest/freq.`);
    freq = noteToSidFreq(note);
    label = note;
  }

  return { freq, len, label };
}

/** Pull the row array for a voice out of a song, accepting several shapes. */
function voiceRows(song, voiceIndex) {
  // Multi-voice forms:
  if (Array.isArray(song.voices)) return song.voices[voiceIndex] ?? [];
  const named = VOICE_NAMES[voiceIndex];
  if (song[named]) return song[named];                 // { melody:[...], bass:[...], harmony:[...] }
  // Mono form: rows go to voice 0; voices 1 & 2 stay empty.
  if (voiceIndex === 0) return song.rows ?? [];
  return [];
}

/** Render a uint16 as a C `0xNNNNu` literal. */
function cWord(v) {
  return `0x${(v & 0xffff).toString(16).toUpperCase().padStart(4, '0')}u`;
}

/**
 * Compile a song to the C64 SID driver's per-voice (freq, len) tables.
 *
 * Accepts up to 3 voices. A mono song (just `rows`) fills voice 0; voices 1 & 2
 * are emitted as a single silent rest that loops, so they stay quiet without
 * desyncing the driver (it has no concept of a "disabled" voice — every voice
 * always walks a table and wraps, so an empty voice must hold at least one
 * looping rest).
 *
 * @param {object} song
 * @param {Array} [song.rows]      mono song → voice 0 (melody)
 * @param {Array} [song.melody]    voice 0
 * @param {Array} [song.bass]      voice 1
 * @param {Array} [song.harmony]   voice 2
 * @param {Array<Array>} [song.voices]  explicit [voice0, voice1, voice2]
 * @param {number} [song.defaultFrames=10]  default note length (driver STEP=10)
 * @returns {{ bytes: Uint8Array, cSource: string, rows: number,
 *             voiceRows: number[], voices: Array<Array<{freq:number,len:number,label:string}>> }}
 *   bytes      = per-voice 3 bytes/note [freq_lo, freq_hi, len], voices concatenated.
 *   cSource    = the three `static const Note melody/bass/harmony[]` arrays.
 *   rows       = total notes across all 3 voices.
 *   voiceRows  = [voice0Count, voice1Count, voice2Count].
 */
export function compileSong(song) {
  if (!song || typeof song !== 'object') {
    throw new Error('C64 song: expected a song object (e.g. { rows:[...] }).');
  }
  const defaultFrames = song.defaultFrames ?? 10; // driver's STEP

  // A silent, looping placeholder for unused voices (driver wraps a 1-note rest).
  const SILENT = [{ freq: N_REST, len: 255, label: 'silent loop' }];

  const voices = [];
  for (let v = 0; v < 3; v++) {
    const rows = voiceRows(song, v).map((r) => normalizeRow(r, defaultFrames));
    voices.push(rows.length ? rows : SILENT.slice());
  }

  // Byte table: per voice, 3 bytes/note [lo, hi, len], voices concatenated.
  const bytes = [];
  for (const rows of voices) {
    for (const { freq, len } of rows) {
      bytes.push(freq & 0xff, (freq >> 8) & 0xff, len & 0xff);
    }
  }

  // C source: the three named Note arrays the driver actually reads.
  const cArrays = voices.map((rows, v) => {
    const name = VOICE_NAMES[v];
    const lines = rows.map(({ freq, len, label }) => {
      return `  { ${cWord(freq)}, ${String(len).padStart(3)} },  /* ${label} */`;
    });
    return `static const Note ${name}[] = {\n${lines.join('\n')}\n};`;
  });

  const cSource =
    '/* Generated by c64/song.js — paste over the demo tables in c64_music.c.\n' +
    ` * Note = { uint16_t freq; uint8_t len; }; freq = round(Hz / ${SID_FREQ_K}).\n` +
    ' * No sentinel: each voice loops by wrapping at end-of-array. */\n\n' +
    cArrays.join('\n\n') + '\n';

  const voiceRowCounts = voices.map((r) => r.length);
  return {
    bytes: new Uint8Array(bytes),
    cSource,
    rows: voiceRowCounts.reduce((a, b) => a + b, 0),
    voiceRows: voiceRowCounts,
    voices,
  };
}

export default compileSong;
