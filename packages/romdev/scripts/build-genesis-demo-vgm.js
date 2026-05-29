#!/usr/bin/env node
// build-genesis-demo-vgm.js — Generate a tiny CC0 chiptune in VGM format.
//
// Emits a short looping PSG arpeggio (no copyrighted material — just three
// SN76489 tones running over a fixed pattern). The resulting .vgm is fed to
// SGDK's xgm2tool to produce the .xgm asset shipped under
// src/platforms/genesis/lib/sgdk/music/demo.xgm.
//
// VGM 1.50 spec reference: https://vgmrips.net/wiki/VGM_Specification
// (We use only PSG writes — opcode 0x50 + 1 byte — and frame waits 0x62 NTSC).
//
// Author: rom-dev-mcp project (CC0 — Public Domain).
//
// Usage:
//   node scripts/build-genesis-demo-vgm.js <out.vgm>

import { writeFile } from "node:fs/promises";

// SN76489 channel registers: tone1/2/3 and noise.
// PSG write byte format:
//   latch byte:    1 <chan:2> <type:1> <data:4>   (0x80-0xFF)
//   data byte:     0 <_:2>   <data:6>            (0x00-0x7F) — high bits of tone period
// Volume: lower = louder. 0x0 = max, 0xF = off.

const CH_TONE = [0, 1, 2];     // channels 0,1,2 are square tones
const CH_NOISE = 3;            // channel 3 is noise

// Compute SN76489 tone period for a given Hz at ~3.579545 MHz Genesis PSG clock.
// period = clock / (32 * freq)
function periodFor(freq) {
  const p = Math.round(3579545 / (32 * freq));
  return Math.max(1, Math.min(0x3FF, p));
}

// Build PSG latch+data bytes to set tone period on a channel.
function setTone(bytes, ch, freq) {
  const p = periodFor(freq);
  const low = p & 0x0F;
  const high = (p >> 4) & 0x3F;
  // Latch: 1, channel<<5, type=0 (tone), low 4 bits
  bytes.push(0x50, 0x80 | (ch << 5) | 0x00 | low);
  // Data: high 6 bits
  bytes.push(0x50, high);
}

// Build PSG byte to set volume on a channel (0=loud, 15=off).
function setVol(bytes, ch, vol) {
  bytes.push(0x50, 0x80 | (ch << 5) | 0x10 | (vol & 0x0F));
}

// 1/60-sec frame wait (NTSC).
function waitFrame(bytes, frames = 1) {
  for (let i = 0; i < frames; i++) bytes.push(0x62);
}

// End-of-stream / loop marker.
function endStream(bytes) {
  bytes.push(0x66);
}

// ── Compose a tiny 4-bar arpeggio over a steady bass ──
//
// Melody pattern: C major arpeggio (C-E-G-C') cycling through 4 chords
// (C, F, G, C). Bass holds the root for each chord. Noise hi-hat on every
// 2nd frame. Tempo ~= 8 frames per note ≈ 130 BPM at NTSC.
//
// Notes in Hz (equal temperament, A4=440):
const NOTE = {
  C3: 130.81, E3: 164.81, G3: 196.00, C4: 261.63, F3: 174.61,
  A3: 220.00, D4: 293.66, B3: 246.94, E4: 329.63, G4: 392.00, A4: 440.00,
};

const arpPatterns = [
  // C major arpeggio
  ["C4", "E4", "G4", "C4", "E4", "G4", "C4", "E4"],
  // F major arpeggio (F-A-C)
  ["C4", "F3", "A3", "C4", "F3", "A3", "C4", "F3"],
  // G major arpeggio (G-B-D)
  ["D4", "G4", "B3", "D4", "G4", "B3", "D4", "G4"],
  // C major arpeggio (resolve)
  ["E4", "G4", "C4", "E4", "G4", "C4", "E4", "G4"],
];
const bassNotes = ["C3", "F3", "G3", "C3"];

const bytes = [];

// Set initial volumes (all silent first).
for (let c = 0; c < 4; c++) setVol(bytes, c, 0x0F);

// Set noise to "periodic noise high freq" via tone-3 frequency (mode=01: tone-3 freq).
// Latch noise: 1,11,1,011 = 0xE7 (periodic-noise-from-ch3-freq)
bytes.push(0x50, 0xE7);

// Play the 4-bar pattern twice (one loop).
const FRAMES_PER_NOTE = 7;   // ~125 BPM at NTSC
for (let bar = 0; bar < arpPatterns.length; bar++) {
  const arp = arpPatterns[bar];
  const bass = bassNotes[bar];

  // Bass note held throughout the bar on ch0.
  setTone(bytes, CH_TONE[0], NOTE[bass]);
  setVol(bytes, CH_TONE[0], 0x06);  // moderate

  for (let n = 0; n < arp.length; n++) {
    // Lead arpeggio on ch1.
    setTone(bytes, CH_TONE[1], NOTE[arp[n]]);
    setVol(bytes, CH_TONE[1], 0x04);

    // Hi-hat on noise channel every other beat.
    if (n % 2 === 0) setVol(bytes, CH_NOISE, 0x09);

    // Hold note for half the frames, then quick fade.
    waitFrame(bytes, Math.floor(FRAMES_PER_NOTE / 2));
    setVol(bytes, CH_TONE[1], 0x08);   // soft tail
    setVol(bytes, CH_NOISE, 0x0F);     // mute noise
    waitFrame(bytes, FRAMES_PER_NOTE - Math.floor(FRAMES_PER_NOTE / 2));
  }
}

// Fade out at end of loop body.
setVol(bytes, CH_TONE[0], 0x0F);
setVol(bytes, CH_TONE[1], 0x0F);
setVol(bytes, CH_TONE[2], 0x0F);
setVol(bytes, CH_NOISE, 0x0F);
waitFrame(bytes, 8);

endStream(bytes);

// ── Build the VGM header (version 1.50, 0x40-byte header) ────────────
const dataBytes = new Uint8Array(bytes);
const VGM_DATA_OFFSET = 0x40;
const totalSize = VGM_DATA_OFFSET + dataBytes.length;
// EoF offset is total file size - 4 (per spec, relative to its own field).
const eofOffsetField = totalSize - 4;

// Total sample count = frames * 735 (NTSC: 44100/60). For the loop, count
// the 0x62 bytes plus large waits (we used none). Cheap enough to recount.
let frames = 0;
for (const b of bytes) if (b === 0x62) frames++;
const totalSamples = frames * 735;

// Loop offset = start of data (loop the whole tune). Stored as offset to
// itself from the loop_offset field at 0x1C (i.e. data_offset - 0x1C).
const loopOffsetField = VGM_DATA_OFFSET - 0x1C;

const header = Buffer.alloc(VGM_DATA_OFFSET);
header.write("Vgm ", 0x00, "ascii");                // 0x00: ident
header.writeUInt32LE(eofOffsetField, 0x04);         // 0x04: EOF offset
header.writeUInt32LE(0x00000150, 0x08);             // 0x08: version 1.50
header.writeUInt32LE(0, 0x0C);                      // 0x0C: SN76489 clock (set below)
header.writeUInt32LE(3579545, 0x0C);                // SN76489 clock = 3.58 MHz
header.writeUInt32LE(0, 0x10);                      // YM2413 clock = 0
header.writeUInt32LE(0, 0x14);                      // GD3 offset = 0 (no tags)
header.writeUInt32LE(totalSamples, 0x18);           // total samples
header.writeUInt32LE(loopOffsetField, 0x1C);        // loop offset
header.writeUInt32LE(totalSamples, 0x20);           // loop samples
header.writeUInt32LE(60, 0x24);                     // rate = 60 Hz NTSC
header.writeUInt16LE(0x0009, 0x28);                 // SN feedback (Sega VDP)
header.writeUInt8(16, 0x2A);                        // SN shift width
header.writeUInt8(0, 0x2B);                         // reserved
header.writeUInt32LE(7670454, 0x2C);                // YM2612 clock = 7.67 MHz
header.writeUInt32LE(0, 0x30);                      // YM2151 clock
header.writeUInt32LE(VGM_DATA_OFFSET - 0x34, 0x34); // data offset (= 0x0C for 1.50)

const out = new Uint8Array(totalSize);
out.set(header, 0);
out.set(dataBytes, VGM_DATA_OFFSET);

const outPath = process.argv[2] || "demo.vgm";
await writeFile(outPath, out);
console.log(`Wrote ${out.length} bytes -> ${outPath}`);
console.log(`  frames=${frames} samples=${totalSamples} dataBytes=${dataBytes.length}`);
