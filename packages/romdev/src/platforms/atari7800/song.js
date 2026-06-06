// Atari 7800 (TIA) song compiler — note/duration song → the exact 3-byte-per-row
// note table the BUNDLED driver (lib/c/atari7800_music.c) plays.
//
// This is NOT a port of an external tool: the TIA has no canonical "song format".
// The playable format is whatever OUR driver reads. Per atari7800_music.c, each
// voice table is a flat uint8_t[] of 3-byte rows, LSB-first in source order:
//
//   { distortion, freq, frames }
//     distortion → AUDC0/AUDC1  (TIA waveform/distortion mode, 0..15)
//     freq       → AUDF0/AUDF1  (5-bit divider, masked &0x1F by the driver; lower = higher pitch)
//     frames     → note length in 60Hz frames; 0 is the SENTINEL (end-of-song → loop to row 0)
//
// The driver reads the table as `static const uint8_t melody_notes[] = { ... }`
// (voice 0, distortion 4) and `bass_notes[]` (voice 1, distortion 6). start_*_note()
// reads triples at idx/idx+1/idx+2 and treats frames==0 as the loop sentinel.
//
// --- TIA pitch math (NTSC) ---------------------------------------------------
// TIA audio clock = NTSC color clock / 114 = 3579545/114 ≈ 31399.5 Hz. The AUDC
// distortion mode picks an extra pre-divider before the AUDF (0..31) counter,
// and a square wave needs a full toggle cycle (×2):
//
//   distortion 4 ("pure tone", melody):  f = AUDIO_CLK / (2·(AUDF+1))
//        AUDF 0 → ~15.7 kHz   ...   AUDF 31 → ~490.6 Hz   (cannot go below ~490 Hz)
//   distortion 6 ("div-by-31", bass):    f = (AUDIO_CLK/31) / (2·(AUDF+1))
//        AUDF 0 → ~506 Hz     ...   AUDF 31 → ~15.8 Hz    (the bass/low register)
//
// To play a note we pick the distortion mode (caller's choice, default 4 melody /
// 6 bass) and snap to the AUDF in 0..31 whose frequency is closest (in cents) to
// the requested note. Because there are only 32 dividers per mode and the spacing
// is harmonic (1/(AUDF+1)) not equal-tempered, the snap is APPROXIMATE — see the
// `approxCents` field returned per row, and the module note at the bottom.

/** Semitone index within an octave for each note letter (C=0). */
const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** NTSC TIA audio clock in Hz: color clock (3.579545 MHz) / 114. */
export const TIA_AUDIO_CLOCK = 3579545 / 114; // ≈ 31399.5 Hz

/** Distortion modes the bundled driver uses. */
export const DIST_MELODY = 4; // pure tone
export const DIST_BASS = 6; // div-by-31, lower register

/**
 * Parse a scientific-pitch note name ("C4", "A#3", "Gb5", "C-4") to an absolute
 * semitone number where C0 = 0, C4 = 48 (so A4 = 57). Copied from the SNES
 * compiler — these are independent files by design.
 * @param {string} name
 * @returns {number} absolute semitone index
 */
export function noteToSemitone(name) {
  const m = /^([A-Ga-g])([#b-]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`atari7800 song: bad note name "${name}" (expected like "C4", "A#3", "Gb5").`);
  const letter = m[1].toUpperCase();
  let semi = NOTE_BASE[letter];
  if (m[2] === '#') semi += 1;
  else if (m[2] === 'b') semi -= 1;
  // '-' is just a separator (FamiTracker-style "C-4"), no accidental.
  const octave = parseInt(m[3], 10);
  return octave * 12 + semi;
}

/**
 * Convert an absolute semitone (C0=0, A4=57) to a frequency in Hz (A4=440).
 * @param {number} semi
 * @returns {number} Hz
 */
export function semitoneToHz(semi) {
  return 440 * Math.pow(2, (semi - 57) / 12);
}

/**
 * The output frequency of an (AUDF, distortion) pair on the NTSC TIA.
 * Only the two pure-tone-ish modes the driver uses are modelled; other modes
 * (polynomial noise etc.) have no meaningful pitch and fall back to mode 4.
 * @param {number} audf  5-bit divider 0..31
 * @param {number} distortion  AUDC mode (4 → pure tone, 6 → div-by-31)
 * @returns {number} Hz
 */
export function audfToHz(audf, distortion = DIST_MELODY) {
  const a = audf & 0x1f;
  const pre = distortion === DIST_BASS ? 31 : 1; // mode 6/10 divide by 31 first
  return TIA_AUDIO_CLOCK / (pre * 2 * (a + 1));
}

/**
 * Snap a note to the nearest reachable AUDF (0..31) for a given distortion mode.
 * "Nearest" = smallest absolute pitch error in cents. Returns the chosen AUDF,
 * the frequency it actually produces, and the snap error in cents (signed:
 * positive = chip plays sharp of the requested note).
 *
 * @param {number} noteSemi   absolute semitone of the requested note (C0=0)
 * @param {number} distortion AUDC mode (default 4 melody)
 * @returns {{ audf:number, hz:number, wantHz:number, cents:number }}
 */
export function noteToAudf(noteSemi, distortion = DIST_MELODY) {
  const wantHz = semitoneToHz(noteSemi);
  let best = null;
  for (let audf = 0; audf <= 31; audf++) {
    const hz = audfToHz(audf, distortion);
    const cents = 1200 * Math.log2(hz / wantHz);
    if (best === null || Math.abs(cents) < Math.abs(best.cents)) {
      best = { audf, hz, wantHz, cents };
    }
  }
  return best;
}

/**
 * Compile one voice's rows into the driver's flat 3-byte-per-row uint8 table.
 * Internal helper; `compileSong` calls it for melody and (optionally) bass.
 *
 * @param {Array<object|string>} rows
 * @param {number} defaultDist  distortion mode for rows that don't specify one
 * @param {number} defaultFrames  frames for shorthand/omitted durations
 * @param {string} arrayName  C array identifier for the emitted snippet
 * @returns {{ bytes:number[], cLines:string[], rows:number, snapped:Array }}
 */
function compileVoice(rows, defaultDist, defaultFrames, arrayName) {
  const bytes = [];
  const cLines = [];
  const snapped = [];

  for (const raw of rows) {
    let note, audf, frames, dist;
    if (typeof raw === 'string') {
      // "C4" or "C4:30" (frames after the colon)
      const [n, t] = raw.split(':');
      note = n;
      frames = t != null ? parseInt(t, 10) : defaultFrames;
    } else {
      note = raw.note;
      audf = raw.audf;
      frames = raw.frames ?? defaultFrames;
      dist = raw.distortion;
    }
    if (dist == null) dist = defaultDist;
    if (dist < 0 || dist > 15) throw new Error(`atari7800 song: distortion ${dist} out of range 0..15.`);
    if (frames < 1 || frames > 255) {
      throw new Error(`atari7800 song: frames ${frames} out of range 1..255 (0 is the loop sentinel).`);
    }

    let cents = 0, hz = 0, wantHz = 0;
    if (audf == null) {
      if (note == null || note === 'rest') {
        // No tone-pitch concept for a rest on this driver (it always sets AUDV>0);
        // approximate silence by emitting the lowest-pitch divider. Prefer real notes.
        audf = 31;
      } else {
        const snap = noteToAudf(noteToSemitone(note), dist);
        audf = snap.audf;
        cents = snap.cents;
        hz = snap.hz;
        wantHz = snap.wantHz;
      }
    }
    if (audf < 0 || audf > 31) throw new Error(`atari7800 song: AUDF ${audf} out of 5-bit range 0..31.`);

    bytes.push(dist & 0xff, audf & 0x1f, frames & 0xff);
    snapped.push({ note, distortion: dist, audf, frames, hz, wantHz, approxCents: Math.round(cents) });

    const label = typeof note === 'string'
      ? `${note} → ${hz ? hz.toFixed(0) + 'Hz' : '?'}${cents ? ` (${cents > 0 ? '+' : ''}${Math.round(cents)}c)` : ''}`
      : `AUDF=${audf}`;
    cLines.push(`  ${dist}, ${audf},${' '.repeat(Math.max(1, 3 - String(audf).length))}${frames},   /* ${label}, ${frames}f */`);
  }

  // Sentinel { 0, 0, 0 } → loop to index 0 (matches the driver's frames==0 check).
  bytes.push(0, 0, 0);
  cLines.push('  0, 0, 0    /* sentinel — loop */');

  const cSource = `static const uint8_t ${arrayName}[] = {\n${cLines.join('\n')}\n};\n`;
  return { bytes, cSource, rows: rows.length, snapped };
}

/**
 * Compile a song to the bundled atari7800_music driver's note table(s).
 *
 * Single-voice (default): pass `{ rows: [...] }` and you get the melody table.
 * Two-voice: pass `{ rows: [...], bass: [...] }` and you get both `melody_notes`
 * and `bass_notes` concatenated in `bytes` (melody first), plus a combined
 * `cSource` with both arrays — drop-in replacements for the two arrays in
 * atari7800_music.c.
 *
 * Each row is one of:
 *   "C5"           — note, default frames
 *   "C5:30"        — note + frames (frames after the colon)
 *   {note:"C5", frames:30, distortion?:4}   — full form; distortion overrides the voice default
 *   {audf:14, frames:30, distortion:4}      — raw AUDF (skips note→pitch snapping)
 *   {note:"rest", frames:15}                — approximated (driver has no true rest)
 *
 * @param {object} song
 * @param {Array<object|string>} song.rows         melody voice (distortion 4 by default)
 * @param {Array<object|string>} [song.bass]       optional bass voice (distortion 6 by default)
 * @param {number} [song.defaultFrames=15]         frames for shorthand/omitted durations
 * @param {number} [song.bassDefaultFrames=60]     frames default for the bass voice
 * @returns {{ bytes:Uint8Array, cSource:string, rows:number,
 *             melody:{bytes:Uint8Array, cSource:string, rows:number, snapped:Array},
 *             bass?:{bytes:Uint8Array, cSource:string, rows:number, snapped:Array} }}
 *   `bytes` is the melody table (melody+bass concatenated if a bass voice is given);
 *   `rows` is the melody row count. Per-voice detail is on `.melody` / `.bass`.
 */
export function compileSong(song) {
  if (!song || !Array.isArray(song.rows)) {
    throw new Error('atari7800 song: expected { rows: [...] }.');
  }
  const defaultFrames = song.defaultFrames ?? 15;

  const melody = compileVoice(song.rows, DIST_MELODY, defaultFrames, 'melody_notes');
  melody.bytes = new Uint8Array(melody.bytes);

  let bass;
  let allBytes = [...melody.bytes];
  let cSource = melody.cSource;

  if (Array.isArray(song.bass)) {
    const bassDefaultFrames = song.bassDefaultFrames ?? 60;
    bass = compileVoice(song.bass, DIST_BASS, bassDefaultFrames, 'bass_notes');
    bass.bytes = new Uint8Array(bass.bytes);
    allBytes = allBytes.concat([...bass.bytes]);
    cSource = `${melody.cSource}\n${bass.cSource}`;
  }

  return {
    bytes: new Uint8Array(allBytes),
    cSource,
    rows: song.rows.length,
    melody,
    ...(bass ? { bass } : {}),
  };
}

export default compileSong;
