// make_chiptune_xm.js — Hand-authored CC0 chiptune XM generator.
//
// Produces `chiptune.xm` — a tiny Fasttracker II module with a single
// square-wave instrument playing a four-note arpeggio loop. The
// output is the canonical input to mmutil (Maxmod's host converter):
//
//   mmutil chiptune.xm -ochiptune_soundbank.bin -hchiptune_soundbank.h
//
// Author/license: romdev project — released CC0 / public domain.
// No third-party tracker modules; everything in this file is generated
// from primitives so the soundbank ships without attribution baggage.
//
// XM format reference: ftp://ftp.modland.com/pub/documents/format_documentation/FastTracker%202%20v2.04%20(.xm).html
//
// Run with: node make_chiptune_xm.js   (writes chiptune.xm next to this file)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ─────────────────────────────────────────────────────────
const u8  = (n) => new Uint8Array([n & 0xff]);
const u16 = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const u32 = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
const padStr = (s, len) => {
  const buf = new Uint8Array(len);
  for (let i = 0; i < s.length && i < len; i++) buf[i] = s.charCodeAt(i);
  return buf;
};
const concat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

// ── XM file structure ───────────────────────────────────────────────
// Header (60 bytes — fixed)
const id      = padStr("Extended Module: ", 17);    // 17 bytes "Extended Module: "
const title   = padStr("romdev chiptune    ", 20);  // 20-byte title
const marker  = u8(0x1a);                            // EOF marker
const tracker = padStr("romdev              ", 20); // 20-byte tracker name
const version = u16(0x0104);                         // version 1.04

// Module header (starts at offset 60)
const headerSize = u32(20 + 256);    // size of THIS struct minus its own 4-byte length = 276
const songLength = u16(1);            // 1 entry in pattern order
const restartPos = u16(0);
const numChans   = u16(2);            // 2 channels (keeps things tiny)
const numPats    = u16(1);            // 1 pattern
const numInsts   = u16(1);            // 1 instrument
const flags      = u16(1);            // bit 0 = linear freq table (Amiga = 0)
const tempo      = u16(6);            // ticks per row
const bpm        = u16(125);          // BPM
const order      = new Uint8Array(256); // pattern order table — entry 0 = pattern 0; rest = 0 (unused but required)

const moduleHeader = concat(headerSize, songLength, restartPos, numChans, numPats, numInsts, flags, tempo, bpm, order);

// ── Pattern 0 ───────────────────────────────────────────────────────
// 16 rows × 2 channels. Channel 0 plays a 4-note arpeggio every 4 rows.
// Channel 1 plays a single sustained bass note that retriggers each loop.
const numRows = 16;

// Use packed note format (high bit set indicates packing).
// Packing byte: bit7=1, bit0=note present, bit1=instrument, bit2=volume,
// bit3=effect type, bit4=effect param.
// Note values: 1..96 = C-0..B-7; XM stores note number where 49 = A-4 (440 Hz).
// We use C-5=61, E-5=65, G-5=68, C-6=73 for ch0 melody; C-4=49 for ch1 bass.

function noteCell(note, inst) {
  // note + instrument only (no volume, no effect)
  if (note === 0 && inst === 0) {
    // empty cell → write packing byte 0x80 (no fields follow)
    return u8(0x80);
  }
  return new Uint8Array([0x80 | 0x01 | 0x02, note, inst]);
}

const melody = [61, 0, 0, 0, 65, 0, 0, 0, 68, 0, 0, 0, 73, 0, 0, 0]; // 16 rows ch0
const bass   = [49, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0]; // ch1 only retrig row 0

const patternBodyParts = [];
for (let row = 0; row < numRows; row++) {
  patternBodyParts.push(noteCell(melody[row], melody[row] ? 1 : 0));
  patternBodyParts.push(noteCell(bass[row],   bass[row]   ? 1 : 0));
}
const patternBody = concat(...patternBodyParts);

const patternHeaderSize = u32(9);
const patternPackingType = u8(0);
const patternRowsField = u16(numRows);
const patternDataSize = u16(patternBody.length);

const pattern = concat(patternHeaderSize, patternPackingType, patternRowsField, patternDataSize, patternBody);

// ── Instrument 1 ────────────────────────────────────────────────────
// 8-bit signed square wave, 64 samples per period @ ~1 kHz at C-4.
// Sample length 256 bytes (4 periods) — looped.
// XM stores 8-bit signed sample data as delta-encoded.

const SAMPLE_LEN = 256;
const sampleRaw = new Int8Array(SAMPLE_LEN);
for (let i = 0; i < SAMPLE_LEN; i++) {
  // Square wave: 50% duty. Volume ~70/127 to avoid clipping in mixer.
  sampleRaw[i] = (i % 64) < 32 ? 70 : -70;
}
// Delta encode (XM format stores deltas, not absolute values).
const sampleDelta = new Int8Array(SAMPLE_LEN);
let prev = 0;
for (let i = 0; i < SAMPLE_LEN; i++) {
  const delta = sampleRaw[i] - prev;
  // Int8 wraparound is fine — mmutil + every XM player decodes via cumulative sum.
  sampleDelta[i] = delta;
  prev = sampleRaw[i];
}
const sampleBytes = new Uint8Array(sampleDelta.buffer, sampleDelta.byteOffset, sampleDelta.byteLength);

// Instrument header — XM splits this into two parts:
//
//  (1) "Instrument header size" (4 bytes) + outer header (name, type,
//      num samples). If numSamples > 0 the extended header follows.
//  (2) Extended header (sample header size, keymap, env, volume etc.)
//  (3) Per-sample headers (40 bytes each).
//  (4) All sample data concatenated.

// We use the modern "full" instrument header — total 263 bytes.
const INST_HEADER_SIZE = 263;       // size of (1)+(2) together
const SAMPLE_HEADER_SIZE = 40;

const instHeaderSize  = u32(INST_HEADER_SIZE);
const instName        = padStr("square              ", 22);
const instType        = u8(0);
const instNumSamples  = u16(1);

// Extended part
const sampleHeaderSizeField = u32(SAMPLE_HEADER_SIZE);
const sampleNumForNotes = new Uint8Array(96); // all zero → all notes use sample 0
const volEnvPoints    = new Uint8Array(48);   // empty envelope (24 points × 2 u16)
const panEnvPoints    = new Uint8Array(48);
const volEnvCount     = u8(0);
const panEnvCount     = u8(0);
const volSustain      = u8(0);
const volLoopStart    = u8(0);
const volLoopEnd      = u8(0);
const panSustain      = u8(0);
const panLoopStart    = u8(0);
const panLoopEnd      = u8(0);
const volType         = u8(0);  // bit0=on → off
const panType         = u8(0);
const vibType         = u8(0);
const vibSweep        = u8(0);
const vibDepth        = u8(0);
const vibRate         = u8(0);
const volFadeout      = u16(0);
const reserved        = new Uint8Array(22);

const instHeader = concat(
  instHeaderSize, instName, instType, instNumSamples,
  sampleHeaderSizeField, sampleNumForNotes,
  volEnvPoints, panEnvPoints,
  volEnvCount, panEnvCount,
  volSustain, volLoopStart, volLoopEnd,
  panSustain, panLoopStart, panLoopEnd,
  volType, panType,
  vibType, vibSweep, vibDepth, vibRate,
  volFadeout, reserved,
);
if (instHeader.length !== INST_HEADER_SIZE) {
  throw new Error(`instrument header size mismatch: got ${instHeader.length}, expected ${INST_HEADER_SIZE}`);
}

// Sample header (40 bytes)
const sampleLength    = u32(SAMPLE_LEN);
const sampleLoopStart = u32(0);
const sampleLoopLength= u32(SAMPLE_LEN);     // forward loop the whole sample
const sampleVolume    = u8(64);              // max
const sampleFinetune  = u8(0);
const sampleTypeByte  = u8(1);               // bit0-1 = loop type 01 (forward); bit4=16bit (off, we use 8-bit)
const samplePanning   = u8(128);             // center
const sampleRelativeNote = u8(0);            // play at default pitch
const samplePackingByte  = u8(0);            // 0 = uncompressed delta
const sampleName      = padStr("square              ", 22);

const sampleHeader = concat(
  sampleLength, sampleLoopStart, sampleLoopLength,
  sampleVolume, sampleFinetune, sampleTypeByte, samplePanning,
  sampleRelativeNote, samplePackingByte, sampleName,
);
if (sampleHeader.length !== SAMPLE_HEADER_SIZE) {
  throw new Error(`sample header size mismatch: got ${sampleHeader.length}, expected ${SAMPLE_HEADER_SIZE}`);
}

const instrument = concat(instHeader, sampleHeader, sampleBytes);

// ── Assemble file ───────────────────────────────────────────────────
const xm = concat(id, title, marker, tracker, version, moduleHeader, pattern, instrument);

const outPath = join(__dirname, "chiptune.xm");
writeFileSync(outPath, xm);
console.log(`wrote ${outPath} (${xm.length} bytes)`);
