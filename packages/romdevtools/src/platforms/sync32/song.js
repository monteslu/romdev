// sync32 song compiler — a note/duration song → (hz, frames) event tables for
// a software synth. The console has NO sound chip: a game fills a 48 kHz
// stereo s16 ring itself, so "music" is whatever the game's own mixer plays.
// The natural unit is therefore Hz + a duration in 60 Hz frames, per voice —
// exactly what a square/triangle/noise voice needs and the shape every port
// hand-writes (jaymcgavren 2026-09-05: `(hz, frames)` note data for a
// three-voice square synth).
//
// Input (single voice):   { rows: [ "C4:16", {note:"A#3", ticks:8}, {hz:440, ticks:4}, "R:8" ] }
// Input (multi voice):    { ticksPerRow?: 8, voices: [ {rows:[...]}, {rows:[...]}, ... ] }
//   a row is a note name ("C4", "A#3", "Gb5", "C-4"), a raw {hz}, or a rest
//   ("R", "-", "." or {rest:true}); ":N" / ticks = duration in frames (60 Hz).
//   Consecutive identical notes are NOT merged (they re-trigger); use one
//   longer row to sustain.
//
// Output: per voice a uint16 (hz, frames) pair array, a C source with the
// arrays + a small struct, and raw bytes (per voice: u16 count then the pairs,
// little-endian). Pitches are exact Hz rounded to integers; a game that wants
// the PSG-quantized feel of a Genesis original can pass `psgQuantize:true`
// (snap to SN76489 dividers) so both targets share one note source.

const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteToSemitone(name) {
  const m = /^([A-Ga-g])([#b-]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`sync32 song: bad note name "${name}" (expected like "C4", "A#3", "Gb5").`);
  let semi = NOTE_BASE[m[1].toUpperCase()];
  if (m[2] === "#") semi += 1; else if (m[2] === "b") semi -= 1;
  return parseInt(m[3], 10) * 12 + semi;
}

export function semitoneToHz(semi, a4Hz = 440) {
  return a4Hz * Math.pow(2, (semi - 57) / 12);
}

/** Snap to the nearest SN76489 tone divider so a Genesis/SMS original's pitch grid is preserved. */
export function psgQuantizeHz(hz, clock = 3579545) {
  if (hz <= 0) return 0;
  let div = Math.round(clock / (32 * hz));
  if (div < 1) div = 1; if (div > 1023) div = 1023;
  return clock / (32 * div);
}

function parseRow(row, defaultTicks, a4Hz, psg) {
  let note, hz, ticks, rest = false;
  if (typeof row === "string") {
    const [n, t] = row.split(":");
    note = n.trim(); if (t !== undefined) ticks = parseInt(t, 10);
    if (/^(r|rest|-|\.)$/i.test(note)) rest = true;
  } else if (row && typeof row === "object") {
    ({ note, hz, ticks } = row);
    ticks = ticks ?? row.dur ?? row.frames;
    if (row.rest || note === undefined && hz === undefined) rest = true;
    if (typeof note === "string" && /^(r|rest|-|\.)$/i.test(note)) rest = true;
  } else throw new Error(`sync32 song: bad row ${JSON.stringify(row)}`);
  ticks = ticks ?? defaultTicks;
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > 65535) throw new Error(`sync32 song: bad duration ${ticks} for row ${JSON.stringify(row)} (1..65535 frames)`);
  if (rest) return { hz: 0, ticks };
  if (hz === undefined) hz = semitoneToHz(noteToSemitone(note), a4Hz);
  if (psg) hz = psgQuantizeHz(hz);
  hz = Math.round(hz);
  if (hz < 1 || hz > 65535) throw new Error(`sync32 song: pitch ${hz} Hz out of the uint16 range for row ${JSON.stringify(row)}`);
  return { hz, ticks };
}

/**
 * @param {{rows?: any[], voices?: {rows:any[], amp?:number}[], ticksPerRow?: number, defaultTicks?: number, name?: string, a4Hz?: number, psgQuantize?: boolean, loop?: boolean}} song
 * @returns {{voices: {events:number[][], amp:number}[], rows:number, bytes:Uint8Array, cSource:string, frames:number}}
 */
export function compileSong(song) {
  const spec = typeof song === "string" ? JSON.parse(song) : song;
  const name = spec.name ?? "song";
  if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`sync32 song: name '${name}' is not a C identifier`);
  const defaultTicks = spec.defaultTicks ?? spec.ticksPerRow ?? 8;
  const a4Hz = spec.a4Hz ?? 440;
  const psg = !!spec.psgQuantize;
  const voiceSpecs = Array.isArray(spec.voices) ? spec.voices
    : Array.isArray(spec.channels) ? spec.channels
    : Array.isArray(spec.rows) ? [{ rows: spec.rows, amp: spec.amp }]
    : null;
  if (!voiceSpecs || !voiceSpecs.length) throw new Error("sync32 song: pass `rows` (one voice) or `voices:[{rows}]` (several).");
  if (voiceSpecs.length > 8) throw new Error("sync32 song: at most 8 voices");
  const voices = voiceSpecs.map((v, i) => {
    if (!Array.isArray(v.rows) || !v.rows.length) throw new Error(`sync32 song: voice ${i} has no rows`);
    const events = v.rows.map((r) => parseRow(r, defaultTicks, a4Hz, psg)).map((e) => [e.hz, e.ticks]);
    const amp = v.amp ?? spec.amp ?? 6000;
    if (!Number.isInteger(amp) || amp < 0 || amp > 32767) throw new Error(`sync32 song: voice ${i} amp ${amp} must be 0..32767`);
    return { events, amp };
  });
  const rows = voices.reduce((s, v) => s + v.events.length, 0);
  const frames = Math.max(...voices.map((v) => v.events.reduce((s, e) => s + e[1], 0)));

  // raw bytes: per voice u16 count, then u16 hz, u16 frames pairs (LE)
  const words = [];
  for (const v of voices) { words.push(v.events.length); for (const [hz, t] of v.events) words.push(hz, t); }
  const bytes = new Uint8Array(words.length * 2);
  words.forEach((w, i) => { bytes[i * 2] = w & 0xff; bytes[i * 2 + 1] = (w >> 8) & 0xff; });

  const N = name.toUpperCase();
  const lines = [
    `/* sync32 song '${name}': ${voices.length} voice(s), ${rows} events, ${frames} frames (${(frames / 60).toFixed(2)} s at 60 Hz). Generated by romdev encodeAudio. */`,
    `/* Each event is (hz, frames); hz 0 = rest. Advance one event per voice when its frames run out; loop at the end. */`,
    `#include <stdint.h>`,
    `#ifndef S32_SONG_TYPES`,
    `#define S32_SONG_TYPES`,
    `typedef struct { const uint16_t *ev; uint16_t nev; int16_t amp; } s32_voice_t;`,
    `typedef struct { uint8_t nvoices; const s32_voice_t *v; } s32_song_t;`,
    `#endif`,
    `#define ${N}_VOICES ${voices.length}`,
    `#define ${N}_FRAMES ${frames}`,
  ];
  voices.forEach((v, i) => {
    lines.push(`static const uint16_t ${name}_v${i}[${v.events.length * 2}] = {`);
    for (let k = 0; k < v.events.length; k += 8) {
      lines.push("  " + v.events.slice(k, k + 8).map(([hz, t]) => `${hz},${t}`).join(",  ") + ",");
    }
    lines.push(`};`);
  });
  lines.push(`static const s32_voice_t ${name}_voices[${voices.length}] = {`);
  voices.forEach((v, i) => lines.push(`  { ${name}_v${i}, ${v.events.length}, ${v.amp} },`));
  lines.push(`};`, `const s32_song_t ${name} = { ${voices.length}, ${name}_voices };`);
  lines.push(
    `/* Minimal square-voice mixer sketch (48 kHz ring, one 60 Hz tick every 800 frames):`,
    ` *   if (++frac == 800) { frac = 0; for each voice: if (--left <= 0) { hz = ev[i*2]; left = ev[i*2+1]; i = (i+1) % nev; period = hz ? 48000/hz : 0; } }`,
    ` *   sample += period ? ((++phase >= period ? (phase = 0) : phase) * 2 < period ? amp : -amp) : 0;`,
    ` * Push in chunks bounded by audio_space() — the ring holds 1024 frames and a video frame is 800. */`,
    "",
  );
  return { voices, rows, bytes, cSource: lines.join("\n"), frames };
}
