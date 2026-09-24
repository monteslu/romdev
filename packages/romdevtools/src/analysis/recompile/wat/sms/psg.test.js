// SMS / Game Gear sound output checked against genesis_plus_gx itself: tiny
// synthetic carts drive every PSG register path (tone frequency latch/data
// writes, zero frequency, attenuation, periodic and white noise, noise
// clocked by tone 2, LFSR resets) and the Game Gear stereo register at
// varying cycles, and every frame's int16 samples must equal the ones gpgx
// hands its libretro audio callback (findDiverge audio, see gpgx-parity.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gpgxParity, divergenceText } from "./gpgx-parity.js";
import { blipFactor, MCLOCK_NTSC, gpgxSoundTables } from "./psg.js";

const T = { timeout: 180000 };

/** A Master System / Game Gear image with a TMR SEGA header (region 4 SMS export, 6 GG export). */
function smsImage(code, { region = 4 } = {}) {
  const rom = new Uint8Array(0x8000);
  rom.set(code, 0);
  for (const [i, ch] of [..."TMR SEGA"].entries()) rom[0x7FF0 + i] = ch.charCodeAt(0);
  rom[0x7FFF] = (region << 4) | 0xC;
  return rom;
}

/** `ld a,n; out (port),a` for each value. */
const outs = (port, vals) => vals.flatMap((v) => [0x3E, v, 0xD3, port]);

/**
 * di; ld sp; the init writes; then a loop that changes tone 0's frequency
 * and attenuation, the noise control and (Game Gear) the stereo register
 * every pass, with a pass length that varies with a RAM counter.
 */
function program({ gg = false, init }) {
  const loop = [
    0x3A, 0x00, 0xC0, 0x3C, 0x32, 0x00, 0xC0, // ld a,($C000); inc a; ld ($C000),a
    0xE6, 0x0F, 0xF6, 0x80, 0xD3, 0x7F, // and $0F; or $80; out ($7F),a   tone 0 low bits
    0x3A, 0x00, 0xC0, 0x0F, 0x0F, 0x0F, 0x0F, 0xE6, 0x0F, 0xF6, 0x90, 0xD3, 0x7F, // tone 0 attenuation
    0x3A, 0x00, 0xC0, 0xE6, 0x07, 0xF6, 0xE0, 0xD3, 0x7F, // noise control (resets the LFSR)
    0x3A, 0x00, 0xC0, 0x07, 0x07, 0x07, 0xE6, 0x3F, 0xD3, 0x7F, // a data byte: tone freq high bits or a volume
    ...(gg ? [0x3A, 0x00, 0xC0, 0x07, 0x07, 0xD3, 0x06] : []), // GG stereo from the counter
    0x3A, 0x00, 0xC0, 0x47, 0x10, 0xFE, // ld b,a; djnz $ (a pass of 13 x counter T)
  ];
  const head = [0xF3, 0x31, 0xF0, 0xDF, ...outs(0x7F, init)];
  return [...head, ...loop, 0x18, (-(loop.length + 2)) & 0xFF];
}

const INIT = [0x8E, 0x0F, 0x90, 0xA5, 0x02, 0xB4, 0xC0, 0x00, 0xD8, 0xE4, 0xF3];

test("blip_buf's resampling factor matches blip_set_rates for 44100 Hz from the NTSC master clock", () => {
  // factor = ceil(2^52 * 44100 / 53693175)
  const exact = (2n ** 52n * 44100n + 53693175n - 1n) / 53693175n;
  assert.equal(blipFactor(MCLOCK_NTSC), exact);
  assert.equal(gpgxSoundTables().blip.blStep.length, 33 * 8);
});

test("SMS: every PSG write path is sample-exact with genesis_plus_gx", T, async () => {
  const r = await gpgxParity({ platform: "sms", rom: smsImage(program({ init: INIT })), maxFrames: 90, audio: true });
  assert.equal(r.diverged, false, divergenceText(r));
  assert.equal(r.audio?.compared, true, "audio was compared");
  assert.equal(r.audio?.referenceSilent, false, "the reference produced sound");
});

test("Game Gear: the stereo register (port $06) is sample-exact with genesis_plus_gx", T, async () => {
  const r = await gpgxParity({ platform: "gg", rom: smsImage(program({ gg: true, init: INIT }), { region: 6 }), maxFrames: 90, audio: true });
  assert.equal(r.diverged, false, divergenceText(r));
  assert.equal(r.audio?.referenceSilent, false, "the reference produced sound");
});

test("control: one attenuation value different in the cart must fail", T, async () => {
  // The cart's program differs from the reference's in tone 1's attenuation
  // ($B4 -> $B5): same machine state except the PSG, so only the audio can
  // tell them apart. gpgxParity builds the cart and the reference from one
  // ROM, so compare two runs' audio through a mismatched pair instead.
  const a = smsImage(program({ init: INIT }));
  const b = smsImage(program({ init: INIT.map((v) => (v === 0xB4 ? 0xB5 : v)) }));
  const ra = await gpgxParity({ platform: "sms", rom: a, maxFrames: 20, audio: true, refRom: b });
  assert.equal(ra.diverged, true, "a one-step attenuation difference must diverge");
  assert.ok(ra.audio?.refFrame != null, `the divergence is in the audio: ${divergenceText(ra)}`);
});
