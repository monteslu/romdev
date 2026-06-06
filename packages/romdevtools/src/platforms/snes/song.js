// SNES song compiler — a simple note/duration song → the byte table the bundled
// SPC700 driver (lib/audio/apu_blob.asm) plays at ARAM $5000.
//
// This is NOT a port of an external tool: the SNES has no single canonical "song
// compiler" the way Genesis has xgm2tool or GBA has mmutil — the playable format
// is whatever OUR driver reads. apu_blob's music engine reads, per row:
//
//   db duration_ticks   ; voice-1 note length, in ~62.5 Hz ticks
//   db pitch_lo         ; → DSP $12 (voice 1 PITCHL)
//   db pitch_hi         ; → DSP $13 (voice 1 PITCHH)
//   ...                  ; then KON voice 1 (re-trigger the sample)
//   db $00              ; terminator → loop to start
//
// So a "note" is a re-trigger of the single loaded BRR sample at a DSP pitch
// rate P. The DSP plays the sample at  native_rate * P / 0x1000 , so to sound a
// pitch `semitones` above the sample's base note you set  P = baseP * 2^(s/12).
//
// Input: a compact song — an array of {note, ticks} (or shorthand strings). The
// note is a scientific-pitch name ("C4", "A#3", "G-5") or a raw DSP P value
// ({p: 0x0400}). We resolve names against a configurable base (which note the
// sample sounds at P=baseP). Output: the 3-byte-per-row table + a $00 terminator,
// either as raw bytes or as an asar `db` block to drop into apu_blob.asm.

/** Semitone index within an octave for each note letter (C=0). */
const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Parse a scientific-pitch note name ("C4", "A#3", "Gb5", "C-4") to an absolute
 * semitone number where C0 = 0, C4 = 48 (so A4 = 57).
 * @param {string} name
 * @returns {number} absolute semitone index
 */
export function noteToSemitone(name) {
  const m = /^([A-Ga-g])([#b-]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`SNES song: bad note name "${name}" (expected like "C4", "A#3", "Gb5").`);
  const letter = m[1].toUpperCase();
  let semi = NOTE_BASE[letter];
  if (m[2] === '#') semi += 1;
  else if (m[2] === 'b') semi -= 1;
  // '-' is just a separator (FamiTracker-style "C-4"), no accidental.
  const octave = parseInt(m[3], 10);
  return octave * 12 + semi;
}

/**
 * DSP pitch value P for a note, given the sample's base note + its base P.
 *   P = round( baseP * 2^((noteSemi - baseSemi)/12) ), clamped to 14 bits.
 * @param {number} noteSemi   absolute semitone of the note to play
 * @param {number} baseSemi   absolute semitone the sample sounds at baseP
 * @param {number} baseP      DSP P at which the sample plays at its base note
 * @returns {number} 14-bit DSP pitch value
 */
export function dspPitch(noteSemi, baseSemi, baseP) {
  const p = Math.round(baseP * Math.pow(2, (noteSemi - baseSemi) / 12));
  return Math.max(0, Math.min(0x3fff, p));
}

/**
 * Compile a song to the apu_blob row table.
 *
 * @param {object} song
 * @param {Array<{note?:string, p?:number, ticks?:number}|string>} song.rows
 *   One entry per note. `{note:"C4", ticks:16}` resolves the pitch from the name;
 *   `{p:0x0400, ticks:16}` uses a raw DSP P. A bare string "C4" or "C4:16" is
 *   shorthand (default ticks from `song.defaultTicks`). A `null`/`"rest"` entry
 *   re-triggers nothing meaningfully on this 1-voice driver — represented as the
 *   same row with the previous pitch (the driver always KONs), so prefer real
 *   notes; rests are approximated by repeating the last pitch.
 * @param {string|number} [song.base="C4"]  the note (or absolute semitone) the
 *   sample sounds at `baseP`.
 * @param {number} [song.baseP=0x1000]  DSP P at which the sample plays `base`.
 * @param {number} [song.defaultTicks=16]  ticks for shorthand entries.
 * @returns {{ bytes: Uint8Array, rows: number, asm: string }}
 *   bytes = the raw table (3*rows + 1 terminator); asm = an asar `db` block.
 */
export function compileSong(song) {
  if (!song || !Array.isArray(song.rows)) {
    throw new Error('SNES song: expected { rows: [...] }.');
  }
  const baseSemi = typeof song.base === 'number' ? song.base : noteToSemitone(song.base ?? 'C4');
  const baseP = song.baseP ?? 0x1000;
  const defaultTicks = song.defaultTicks ?? 16;

  const out = [];
  const asmLines = [];
  let lastP = baseP;

  for (const raw of song.rows) {
    let note, p, ticks;
    if (typeof raw === 'string') {
      // "C4" or "C4:16"
      const [n, t] = raw.split(':');
      note = n;
      ticks = t != null ? parseInt(t, 10) : defaultTicks;
    } else {
      note = raw.note;
      p = raw.p;
      ticks = raw.ticks ?? defaultTicks;
    }
    if (ticks < 1 || ticks > 255) throw new Error(`SNES song: ticks ${ticks} out of range 1..255.`);

    if (p == null) {
      if (note == null || note === 'rest' || note === null) {
        p = lastP; // 1-voice driver always KONs; approximate a rest by holding pitch
      } else {
        p = dspPitch(noteToSemitone(note), baseSemi, baseP);
      }
    }
    if (p < 0 || p > 0x3fff) throw new Error(`SNES song: DSP pitch ${p} out of 14-bit range.`);
    lastP = p;

    const lo = p & 0xff, hi = (p >> 8) & 0xff;
    out.push(ticks & 0xff, lo, hi);
    asmLines.push(`  db $${(ticks & 0xff).toString(16).padStart(2, '0').toUpperCase()}, ` +
      `$${lo.toString(16).padStart(2, '0').toUpperCase()}, $${hi.toString(16).padStart(2, '0').toUpperCase()}` +
      `        ; ${typeof note === 'string' ? note : ('P=$' + p.toString(16))}, ${ticks}t`);
  }
  out.push(0x00); // terminator → loop
  asmLines.push('  db $00                  ; loop');

  return {
    bytes: new Uint8Array(out),
    rows: song.rows.length,
    asm: `song:\n${asmLines.join('\n')}\n`,
  };
}

export default compileSong;
