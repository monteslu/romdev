// Lynx (Mikey) song compiler — note/duration song → the exact bytestream the
// BUNDLED cc65 sound driver (lib/cc65-src/lynx-snd.s) plays via lynx_snd_play().
//
// This is NOT a port of an external tool: the Lynx has no canonical "song
// compiler". The only playable format is whatever OUR bundled driver reads, and
// that driver is cc65's lynx-snd.s. We emit the byte stream its SndGetCmd /
// SndNewNote loop parses, and we pick note values that index its built-in
// SndPrescaler / SndReload pitch tables.
//
// ── Byte-stream format (parsed in SndGetCmd, lynx-snd.s) ────────────────────
//   cmd0:  lda (ptr)
//          beq SndStop          ; byte $00            → TERMINATE the stream
//          bmi (high bit set)   ; byte $80..$ff       → COMMAND (low 7 bits
//                                                       index SndCmdsLo/Hi)
//          else                 ; byte $01..$7f       → NOTE, consumes TWO bytes:
//                                 byte0 = note index (1..127), byte1 = length in
//                                 240 Hz player ticks (SndDelay).  (SndNewNote)
//
//   So a melody row is the pair  [noteIndex, lengthTicks].  A rest is the
//   command  $82 (SndPause) followed by  [lengthTicks].  The stream ends with a
//   single  $00  byte (SndStop). These three are all this compiler emits; the
//   richer commands ($84 SndSetInstr, $85 SndNewNote2, $86 SndCallPattern,
//   $88..$8d envelopes, $8e stereo, $91 tempo, $92 SndReturnAll) are documented
//   in lynx_music.c but are out of scope for a plain note/duration song.
//
// ── How a note index becomes a pitch (SndNewNote → SndPrescaler/SndReload) ──
//   SndNewNote does:  lda SndPrescaler,x → AUDx ctl (timer clock select)
//                     lda SndReload,x    → AUDx backup (timer reload)
//   where X is the note index. Both tables hold 128 entries. The Mikey audio
//   timer emits a square wave at:
//
//       f = 1_000_000 / ( 2^prescaler * (reload+1) * 2 )      [Hz]
//
//   (1 MHz Mikey base; timer underflows every (reload+1) ticks of a
//   2^prescaler-µs clock; the output toggles each underflow → ÷2.) A reload
//   byte of $00 wraps as 256. This formula, applied to the bundled tables,
//   reproduces a chromatic-ish scale with **index 28 = 440.14 Hz = A4 (+1
//   cent)** — the anchor this compiler keys off.
//
// ── IMPORTANT approximation (read this) ─────────────────────────────────────
//   The bundled SndReload table was hand-tuned "by ear" (see lynx-snd.s /
//   lynx_music.c headers) and is NOT a uniform 12-semitone-per-octave scale.
//   Measured step sizes between adjacent indices range from ~45 cents at the
//   low end to ~170 cents (wider than a whole tone) in the mid range. There is
//   no exact integer "midi → index" formula. So this compiler does the same
//   thing the Atari 7800 32-pitch driver does: it computes each note's IDEAL
//   equal-tempered frequency (from a configurable base, default A4=440) and
//   SNAPS to the table index whose Mikey frequency is closest in cents. Each
//   row reports how many cents it had to bend. Well-served notes (A2,A4,A5,
//   most of octaves 3–6) land within a few cents; sparse regions can be off by
//   a quarter-tone. Use `{ index: N }` to bypass snapping and emit a raw index.

/** Semitone index within an octave for each note letter (C=0). */
const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * The bundled driver's SndPrescaler table (lynx-snd.s) — timer clock select
 * (0..6) per note index. 128 entries; index 0 is the rest/terminator slot.
 * @type {number[]}
 */
export const SND_PRESCALER = [
  0x00, 0x06, 0x06, 0x06, 0x06, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x04, 0x04, 0x04, 0x04,
  0x04, 0x04, 0x04, 0x04, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x02, 0x02,
  0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x01, 0x01, 0x01, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/**
 * The bundled driver's SndReload table (lynx-snd.s) — timer backup/reload per
 * note index. 128 entries; a byte of $00 means 256 (timer wrap).
 * @type {number[]}
 */
export const SND_RELOAD = [
  0x00, 0x9A, 0x96, 0x8F, 0x86, 0xFA, 0xE5, 0xD1, 0xBE, 0xAC, 0x9C, 0x8D, 0x00, 0xE8, 0xD3, 0xC0,
  0xAF, 0xA0, 0x93, 0x87, 0xFA, 0xE7, 0xD6, 0xC6, 0xB8, 0xAC, 0xA1, 0x96, 0x8D, 0x84, 0xFA, 0xEB,
  0xDE, 0xD2, 0xC7, 0xBC, 0xB3, 0xAA, 0xA1, 0x9A, 0x93, 0x8C, 0x86, 0x00, 0xF5, 0xEB, 0xE1, 0xD8,
  0xCF, 0xC7, 0xC0, 0xB9, 0xB2, 0xAB, 0xA5, 0xA0, 0x9A, 0x95, 0x90, 0x8B, 0x87, 0x82, 0xFD, 0xF5,
  0xEE, 0xE7, 0xE0, 0xD9, 0xD3, 0xCD, 0xC8, 0xC2, 0xBD, 0xB8, 0xB3, 0xAE, 0xAA, 0xA5, 0xA1, 0x9D,
  0x99, 0x96, 0x92, 0x8F, 0x8B, 0x88, 0x85, 0x82, 0x7F, 0x7C, 0x79, 0x77, 0x74, 0x72, 0x6F, 0x6D,
  0x6B, 0x69, 0x67, 0x64, 0x63, 0x61, 0x5F, 0x5D, 0x5B, 0x59, 0x58, 0x56, 0x55, 0x53, 0x51, 0x50,
  0x4F, 0x4D, 0x4C, 0x4B, 0x49, 0x48, 0x47, 0x46, 0x44, 0x43, 0x42, 0x41, 0x40, 0x3F, 0x3E, 0x3D,
];

/** Command byte: rest for N ticks (next byte = N). SndPause in lynx-snd.s. */
export const CMD_PAUSE = 0x82;
/** Stream terminator byte. SndStop in lynx-snd.s (a $00 byte). */
export const STREAM_END = 0x00;

/**
 * Parse a scientific-pitch note name ("C4", "A#3", "Gb5", "C-4") to an absolute
 * semitone number where C0 = 0, C4 = 48, A4 = 57. (Same convention as the SNES
 * compiler — copied so the files stay independent.)
 * @param {string} name
 * @returns {number} absolute semitone index
 */
export function noteToSemitone(name) {
  const m = /^([A-Ga-g])([#b-]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`Lynx song: bad note name "${name}" (expected like "C4", "A#3", "Gb5").`);
  const letter = m[1].toUpperCase();
  let semi = NOTE_BASE[letter];
  if (m[2] === '#') semi += 1;
  else if (m[2] === 'b') semi -= 1;
  // '-' is just a separator (FamiTracker-style "C-4"), no accidental.
  const octave = parseInt(m[3], 10);
  return octave * 12 + semi;
}

/**
 * Mikey square-wave frequency (Hz) produced by note index `i` using the bundled
 * SndPrescaler / SndReload tables.  f = 1e6 / (2^prescaler * (reload+1) * 2),
 * with reload $00 wrapping to 256.
 * @param {number} i note index 1..127
 * @returns {number} frequency in Hz
 */
export function indexToFreq(i) {
  if (i < 1 || i > 127) throw new Error(`Lynx song: note index ${i} out of range 1..127.`);
  const presc = SND_PRESCALER[i];
  const reload = SND_RELOAD[i] === 0 ? 256 : SND_RELOAD[i];
  return 1e6 / (Math.pow(2, presc) * (reload + 1) * 2);
}

/**
 * Find the bundled-table note index whose Mikey frequency is closest (in cents)
 * to `targetHz`. The table is non-uniform and hand-tuned, so this is a SNAP to
 * the nearest available pitch (see the approximation note at the top of file).
 * @param {number} targetHz desired frequency in Hz
 * @returns {{index:number, freq:number, cents:number}} chosen index, its actual
 *   frequency, and the bend (positive = table is sharp of target) in cents.
 */
export function snapToIndex(targetHz) {
  let best = 1;
  let bestCents = Infinity;
  for (let i = 1; i <= 127; i++) {
    const cents = 1200 * Math.log2(indexToFreq(i) / targetHz);
    if (Math.abs(cents) < Math.abs(bestCents)) {
      bestCents = cents;
      best = i;
    }
  }
  return { index: best, freq: indexToFreq(best), cents: bestCents };
}

/**
 * Frequency (Hz) of an absolute semitone in equal temperament, given the base.
 * @param {number} semi absolute semitone (C0=0)
 * @param {number} baseSemi absolute semitone of the reference pitch
 * @param {number} baseHz frequency of the reference pitch
 * @returns {number} frequency in Hz
 */
export function semitoneToFreq(semi, baseSemi, baseHz) {
  return baseHz * Math.pow(2, (semi - baseSemi) / 12);
}

/**
 * Compile a song to the bundled cc65 Lynx driver's bytestream.
 *
 * @param {object} song
 * @param {Array<{note?:string, index?:number, rest?:boolean, ticks?:number}|string>} song.rows
 *   One entry per row. Forms:
 *     - `{note:"A4", ticks:30}`     → snap A4 to the nearest table index, length 30 ticks.
 *     - `{index:28, ticks:30}`      → emit raw note index 28 (no snapping), length 30.
 *     - `{rest:true, ticks:30}`     → emit a $82 (SndPause) rest of 30 ticks.
 *     - `"A4"` / `"A4:30"`          → shorthand for `{note, ticks}` (ticks default below).
 *     - `"rest"` / `"rest:30"`      → shorthand for a rest.
 * @param {string|number} [song.base="A4"]   reference note name (or absolute
 *   semitone) for the equal-tempered grid the snapper targets.
 * @param {number} [song.baseHz=440]   frequency of `base` in Hz.
 * @param {number} [song.defaultTicks=30]  ticks for shorthand entries (30 @ 240Hz ≈ 125 ms).
 * @returns {{bytes: Uint8Array, cSource: string, asm: string, rows: number,
 *           detail: Array<{kind:string, note?:string, index?:number, ticks:number,
 *                          freq?:number, target?:number, cents?:number}>}}
 *   bytes = the raw stream (note/length pairs + rest commands + a $00 terminator);
 *   cSource = a drop-in `unsigned char song[] = { ... };` matching lynx_music.c's
 *   `demo_music`; asm = a ca65 `.byte` block; rows = number of input rows;
 *   detail = per-row resolution info (incl. snap error in cents).
 */
export function compileSong(song) {
  if (!song || !Array.isArray(song.rows)) {
    throw new Error('Lynx song: expected { rows: [...] }.');
  }
  const baseSemi = typeof song.base === 'number' ? song.base : noteToSemitone(song.base ?? 'A4');
  const baseHz = song.baseHz ?? 440;
  const defaultTicks = song.defaultTicks ?? 30;

  const out = [];
  const detail = [];

  for (const raw of song.rows) {
    let note;
    let index;
    let rest = false;
    let ticks;

    if (typeof raw === 'string') {
      const [n, t] = raw.split(':');
      ticks = t != null ? parseInt(t, 10) : defaultTicks;
      if (n === 'rest' || n === 'R' || n === '-') rest = true;
      else note = n;
    } else {
      note = raw.note;
      index = raw.index;
      rest = !!raw.rest;
      ticks = raw.ticks ?? defaultTicks;
    }

    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 255) {
      throw new Error(`Lynx song: ticks ${ticks} out of range 1..255.`);
    }

    if (rest) {
      // Rest = SndPause command ($82) + length byte.
      out.push(CMD_PAUSE, ticks & 0xff);
      detail.push({ kind: 'rest', ticks });
      continue;
    }

    if (index == null && note == null) {
      throw new Error('Lynx song: a row needs `note`, `index`, or `rest`.');
    }

    if (index != null) {
      if (!Number.isInteger(index) || index < 1 || index > 127) {
        throw new Error(`Lynx song: raw index ${index} out of range 1..127.`);
      }
      out.push(index & 0xff, ticks & 0xff);
      detail.push({ kind: 'note', note, index, ticks, freq: indexToFreq(index) });
      continue;
    }

    // Resolve a note name → ideal frequency → snap to nearest table index.
    const target = semitoneToFreq(noteToSemitone(note), baseSemi, baseHz);
    const snap = snapToIndex(target);
    out.push(snap.index & 0xff, ticks & 0xff);
    detail.push({
      kind: 'note',
      note,
      index: snap.index,
      ticks,
      freq: snap.freq,
      target,
      cents: snap.cents,
    });
  }

  out.push(STREAM_END); // $00 → SndStop, terminate the stream.

  const bytes = new Uint8Array(out);

  // ── C source: a drop-in replacement for lynx_music.c's demo_music[] ──
  const hex = (b) => '0x' + (b & 0xff).toString(16).padStart(2, '0').toUpperCase();
  const cLines = [];
  cLines.push('/* Generated by lynx/song.js — drop into the bundled cc65 driver:');
  cLines.push(' *   lynx_snd_init();');
  cLines.push(' *   lynx_snd_play(0, song);');
  cLines.push(' * Byte stream parsed by SndGetCmd (lynx-snd.s): note/length pairs,');
  cLines.push(' * 0x82=rest, 0x00=end. Note indices snapped to SndReload/SndPrescaler. */');
  cLines.push('unsigned char song[] = {');
  for (const d of detail) {
    if (d.kind === 'rest') {
      cLines.push(`  ${hex(CMD_PAUSE)}, ${String(d.ticks).padStart(3)},  /* rest ${d.ticks}t */`);
    } else {
      const c = d.cents != null ? ` ${d.cents >= 0 ? '+' : ''}${d.cents.toFixed(0)}c` : '';
      const nm = d.note ? d.note : `idx${d.index}`;
      cLines.push(`  ${String(d.index).padStart(3)}, ${String(d.ticks).padStart(3)},  /* ${nm} @ ${d.freq.toFixed(1)}Hz${c}, ${d.ticks}t */`);
    }
  }
  cLines.push(`  ${hex(STREAM_END)}            /* SndStop — end of stream */`);
  cLines.push('};');
  const cSource = cLines.join('\n') + '\n';

  // ── ca65 .byte block (same data, asm flavour) ──
  const asmLines = ['song:'];
  for (const d of detail) {
    if (d.kind === 'rest') {
      asmLines.push(`        .byte $82, ${d.ticks}        ; rest ${d.ticks}t`);
    } else {
      const nm = d.note ? d.note : `idx${d.index}`;
      asmLines.push(`        .byte ${String(d.index).padStart(3)}, ${String(d.ticks).padStart(3)}      ; ${nm} ${d.freq.toFixed(0)}Hz`);
    }
  }
  asmLines.push('        .byte $00              ; SndStop');
  const asm = asmLines.join('\n') + '\n';

  return { bytes, cSource, asm, rows: song.rows.length, detail };
}

export default compileSong;
