// NES APU audio for the WAT cart: a port of fceumm's src/sound.c low-quality
// renderer (FSettings.soundq 0, the libretro core's "fceumm_sndquality" =
// "Low" default) and src/filter.c SexyFilter, into the wasmcart int16 stereo
// ring at 48000 Hz.
//
// fceumm renders LAZILY. The two LQ workers
//   RDoSQLQ               both pulse channels   (DoSQ1 = DoSQ2)
//   RDoTriangleNoisePCMLQ triangle, noise, DMC  (DoTriangle = DoNoise = DoPCM)
// accumulate into Wave[] in 1/16-sample steps (nesincsize per step, the
// channel accumulators sqacc/lq_triacc/lq_noiseacc) from ChannelBC up to
// end = (SOUNDTS << 16) / soundtsinc, with the register state in force at
// that moment. They are called where fceumm calls them: before every APU
// register write that changes their state (Write_PSG, Write_DMCRegs,
// StatusWrite), at the start of FrameSoundStuff (the frame sequencer), when
// the DMC output unit steps RawDALatch (with fceumm's "Unbelievably ugly
// hack": SOUNDTS moved back to the exact bit time), and at the end of the
// frame (FlushEmulateSound), which then runs SexyFilter over the finished
// samples, carries the partial sample, and resets ChannelBC/soundtsoffs.
// SOUNDTS = sound_timestamp + soundtsoffs, sound_timestamp = CPU cycles
// since the frame began ($ts - $sndts0).
//
// The libretro side (libretro.c retro_run) hands the int16 mono samples to
// the frontend as stereo with the default "null" stereo filter: L = R.
//
// Everything here is state the CPU cannot observe, so audio cannot change a
// verified cart's RAM, CPU or picture.
//
// Plain JS ESM + JSDoc.

/** Linear memory for audio (the 64KB above the trace ring, below banked PRG). */
export const AUDIO = 0xF0000;       // int16 stereo ring, AUDIO_CAP frames
export const AUDIO_CAP = 4096;
export const WAVE = 0xF4000;        // Wave[2048 + 512] int32
export const WL1 = 0xF6800;         // wlookup1[32] u32
export const WL2 = 0xF6900;         // wlookup2[203] u32
export const NOISETAB = 0xF6C40;    // NTSCNoiseFreqTable[16] u32
export const AUDIO_CURSOR = 0xF6C80;
/** mute mask byte: bit 0 sq1, 1 sq2, 2 triangle, 3 noise, 4 DMC (fceumm_apu_N "disabled" = that channel's volume 0) */
export const MUTE = 0xF6CC0;
export const MUTE_CHANNELS = ["sq1", "sq2", "tri", "noise", "dmc"];

/** fceumm_sndvolume default "7": (int)(atof("7") * 25.6) = 179 -> FSettings.SoundVolume. */
const SOUND_VOLUME = Math.trunc(7 * 25.6);
const SND_RATE = 48000;

/**
 * The constants SetSoundVariables / SexyFilter derive, computed exactly as
 * the C does (double arithmetic, then the integer conversions).
 * @param {{ntscCpu: number, wl1: [number, number, number, number], wl2: [number, number, number, number]}} src
 */
export function soundConstants(src) {
  const wlookup1 = [0];
  for (let x = 1; x < 32; x++) {
    // (double)16*16*16*4*95.52 / ((double)8128 / x + 100), stored to uint32, then >>= 4 (soundq 0)
    wlookup1.push(Math.trunc(16 * 16 * 16 * 4 * src.wl1[0] / (src.wl1[1] / x + src.wl1[2])) >>> src.wl1[3]);
  }
  const wlookup2 = [0];
  for (let x = 1; x < 203; x++) wlookup2.push(Math.trunc(16 * 16 * 16 * 4 * src.wl2[0] / (src.wl2[1] / x + src.wl2[2])) >>> src.wl2[3]);
  // nesincsize = (int64)((1 << 17) * (double)NTSC_CPU / (SndRate * 16))
  const nesincsize = Math.trunc((2 ** 17) * src.ntscCpu / (SND_RATE * 16));
  // soundtsinc = (uint32)((uint64)((double)NTSC_CPU * 65536.0) / (SndRate * 16)): integer division
  const soundtsinc = Number(BigInt(Math.trunc(src.ntscCpu * 65536.0)) / BigInt(SND_RATE * 16)) >>> 0;
  // FCEUSND_Reset: sqacc[x] = ((uint32)2048 << 17) / nesincsize
  const sqacc0 = Math.trunc((2048 * 2 ** 17) / nesincsize) | 0;
  // SexyFilter: mul1 = (94 << 16) / SndRate; mul2 = (24 << 16) / SndRate;
  // vmul = (SoundVolume << 16) * 3 / 4 / 100, * 2 for soundq 0
  const mul1 = Math.trunc((94 << 16) / SND_RATE), mul2 = Math.trunc((24 << 16) / SND_RATE);
  const vmul = Math.trunc(Math.trunc(Math.trunc((SOUND_VOLUME << 16) * 3) / 4) / 100) * 2;
  return { wlookup1, wlookup2, nesincsize, soundtsinc, sqacc0, mul1, mul2, vmul };
}

/** Audio globals. */
export function apuGlobalsWat(k) {
  const z = ["sndts0", "stoffs", "cbc0", "cbc2", "rdc0", "rdc1", "curfreq0", "curfreq1", "sweepon0", "sweepon1",
    "sweepcnt0", "sweepcnt1", "sweeprel0", "sweeprel1", "trimode", "tricount", "tristep", "lqtcout", "lqtriacc",
    "lqnoiseacc", "rawda", "sndframes", "ndmcout",
    "envspd0", "envmode0", "envcnt0", "envvol0", "envrel0",
    "envspd1", "envmode1", "envcnt1", "envvol1", "envrel1",
    "envspd2", "envmode2", "envcnt2", "envvol2", "envrel2"];
  let s = z.map((n) => `  (global $${n} (mut i32) (i32.const 0))\n`).join("");
  s += `  (global $sqacc0 (mut i32) (i32.const ${k.sqacc0}))\n  (global $sqacc1 (mut i32) (i32.const ${k.sqacc0}))\n`;
  s += "  (global $nreg (mut i32) (i32.const 1))\n";
  s += "  (global $sfacc1 (mut i64) (i64.const 0))\n  (global $sfacc2 (mut i64) (i64.const 0))\n";
  return s;
}

/**
 * The audio functions.
 * @param {object} o
 * @param {ReturnType<typeof soundConstants>} o.k
 * @param {number} o.APUREG  the $4000-$4017 write shadow (fceumm PSG[])
 * The mute mask at MUTE (bit i = channel i of MUTE_CHANNELS) is fceumm's
 * per-channel FSettings.*Volume set to 0 instead of 256 (fceumm_apu_N
 * "disabled"); it is 0 in a normal cart and exists for the verifier's
 * drop-channel must-fail control.
 */
export function apuWat({ k, APUREG }) {
  const PSG = (i) => `(i32.load8_u (i32.const ${APUREG + i}))`;
  const SOUNDTS = "(i32.add (i32.sub (global.get $ts) (global.get $sndts0)) (global.get $stoffs))";
  const END = `(i32.div_u (i32.shl ${SOUNDTS} (i32.const 16)) (i32.const ${k.soundtsinc}))`;
  const muted = (bit) => `(i32.and (i32.load8_u (i32.const ${MUTE})) (i32.const ${1 << bit}))`;
  // x * vol / 256 with vol 256 or 0
  const scale = (e, bit) => `(select (i32.const 0) ${e} ${muted(bit)})`;
  const WL2 = (e) => `(i32.load (i32.add (i32.const ${k.WL2}) (i32.shl (select ${e} (i32.const 202) (i32.lt_u ${e} (i32.const 203))) (i32.const 2))))`;
  const env = (P, f) => `$env${f}${P}`;
  return `
  ;; CheckFreq(cf, sr): the sweep unit would overflow -> 0 (silence)
  (func $checkfreq (param $cf i32) (param $sr i32) (result i32)
    (if (i32.eqz (i32.and (local.get $sr) (i32.const 8)))
      (then (if (i32.and (i32.add (i32.shr_u (local.get $cf) (i32.and (local.get $sr) (i32.const 7))) (local.get $cf)) (i32.const 0x800))
        (then (return (i32.const 0))))))
    (i32.const 1))

  ;; RDoSQLQ: both pulse channels up to SOUNDTS
  (func $snd_sq
    (local $start i32) (local $end i32) (local $v i32) (local $x i32)
    (local $inie0 i32) (local $inie1 i32) (local $amp0 i32) (local $amp1 i32)
    (local $rt0 i32) (local $rt1 i32) (local $freq0 i32) (local $freq1 i32) (local $tot i32)
    (local.set $start (global.get $cbc0))
    (local.set $end ${END})
    (if (i32.le_s (local.get $end) (local.get $start)) (then (return)))
    (global.set $cbc0 (local.get $end))
${[0, 1].map((x) => `    (local.set $inie${x} (i32.const ${k.nesincsize}))
    (if (i32.or (i32.lt_s (global.get $curfreq${x}) (i32.const 8)) (i32.gt_s (global.get $curfreq${x}) (i32.const 0x7FF)))
      (then (local.set $inie${x} (i32.const 0))))
    (if (i32.eqz (call $checkfreq (global.get $curfreq${x}) ${PSG((x << 2) | 1)})) (then (local.set $inie${x} (i32.const 0))))
    (if (i32.eqz (global.get $len${x})) (then (local.set $inie${x} (i32.const 0))))
    (local.set $amp${x} (if (result i32) (i32.and (global.get $envmode${x}) (i32.const 1)) (then (global.get $envspd${x})) (else (global.get $envvol${x}))))
    (if ${muted(x)} (then (local.set $amp${x} (i32.const 0))))
    (if (i32.eqz (local.get $inie${x})) (then (local.set $amp${x} (i32.const 0))))
    ;; RectDuties = {1, 2, 4, 6}[duty]
    (local.set $rt${x} (i32.load8_u (i32.add (i32.const ${k.DUTIES}) (i32.shr_u (i32.and ${PSG(x << 2)} (i32.const 0xC0)) (i32.const 6)))))
    (local.set $freq${x} (i32.shl (i32.shl (i32.add (global.get $curfreq${x}) (i32.const 1)) (i32.const 1)) (i32.const 17)))`).join("\n")}
    (local.set $tot (call $sq_out (local.get $amp0) (local.get $rt0) (local.get $amp1) (local.get $rt1)))
    (if (i32.and (i32.eqz (local.get $inie0)) (i32.eqz (local.get $inie1))) (then (return)))
    (local.set $v (local.get $start))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $v) (local.get $end)))
      (call $wave_add (local.get $v) (local.get $tot))
      (global.set $sqacc0 (i32.sub (global.get $sqacc0) (local.get $inie0)))
      (global.set $sqacc1 (i32.sub (global.get $sqacc1) (local.get $inie1)))
      (if (i32.le_s (global.get $sqacc0) (i32.const 0))
        (then
          (block $r0 (loop $rl0
            (global.set $sqacc0 (i32.add (global.get $sqacc0) (local.get $freq0)))
            (global.set $rdc0 (i32.and (i32.add (global.get $rdc0) (i32.const 1)) (i32.const 7)))
            (br_if $rl0 (i32.le_s (global.get $sqacc0) (i32.const 0)))))
          (local.set $tot (call $sq_out (local.get $amp0) (local.get $rt0) (local.get $amp1) (local.get $rt1)))))
      (if (i32.le_s (global.get $sqacc1) (i32.const 0))
        (then
          (block $r1 (loop $rl1
            (global.set $sqacc1 (i32.add (global.get $sqacc1) (local.get $freq1)))
            (global.set $rdc1 (i32.and (i32.add (global.get $rdc1) (i32.const 1)) (i32.const 7)))
            (br_if $rl1 (i32.le_s (global.get $sqacc1) (i32.const 0)))))
          (local.set $tot (call $sq_out (local.get $amp0) (local.get $rt0) (local.get $amp1) (local.get $rt1)))))
      (local.set $v (i32.add (local.get $v) (i32.const 1)))
      (br $l))))

  ;; wlookup1[(ttable[0][RectDutyCount[0]] + ttable[1][RectDutyCount[1]]) & 31]
  (func $sq_out (param $amp0 i32) (param $rt0 i32) (param $amp1 i32) (param $rt1 i32) (result i32)
    (i32.load (i32.add (i32.const ${k.WL1}) (i32.shl (i32.and (i32.add
      (select (local.get $amp0) (i32.const 0) (i32.lt_s (global.get $rdc0) (local.get $rt0)))
      (select (local.get $amp1) (i32.const 0) (i32.lt_s (global.get $rdc1) (local.get $rt1))))
      (i32.const 31)) (i32.const 2)))))

  ;; Wave[V >> 4] += out
  (func $wave_add (param $v i32) (param $out i32)
    (local $p i32)
    (local.set $p (i32.add (i32.const ${k.WAVE}) (i32.shl (i32.shr_s (local.get $v) (i32.const 4)) (i32.const 2))))
    (i32.store (local.get $p) (i32.add (i32.load (local.get $p)) (local.get $out))))

  ;; RDoTriangleNoisePCMLQ: triangle, noise and the DMC DAC up to SOUNDTS
  (func $snd_tnp
    (local $start i32) (local $end i32) (local $v i32) (local $inie0 i32) (local $inie1 i32)
    (local $freq0 i32) (local $amp0 i32) (local $noiseout i32) (local $nshift i32)
    (local $stc i32) (local $sdmc i32) (local $tot i32) (local $nf i32)
    (local.set $start (global.get $cbc2))
    (local.set $end ${END})
    (if (i32.le_s (local.get $end) (local.get $start)) (then (return)))
    (global.set $cbc2 (local.get $end))
    (local.set $inie0 (i32.const ${k.nesincsize}))
    (local.set $inie1 (i32.const ${k.nesincsize}))
    (local.set $freq0 (i32.add (i32.or ${PSG(0xA)} (i32.shl (i32.and ${PSG(0xB)} (i32.const 7)) (i32.const 8))) (i32.const 1)))
    (if (i32.or (i32.or (i32.eqz (global.get $len2)) (i32.eqz (global.get $tricount))) (i32.le_s (local.get $freq0) (i32.const 4)))
      (then (local.set $inie0 (i32.const 0))))
    (local.set $freq0 (i32.shl (local.get $freq0) (i32.const 17)))
    (local.set $amp0 (if (result i32) (i32.and (global.get $envmode2) (i32.const 1)) (then (global.get $envspd2)) (else (global.get $envvol2))))
    (if ${muted(3)} (then (local.set $amp0 (i32.const 0))))
    (local.set $amp0 (i32.shl (local.get $amp0) (i32.const 1)))
    (if (i32.eqz (global.get $len3)) (then (local.set $amp0 (i32.const 0)) (local.set $inie1 (i32.const 0))))
    ;; noiseout = amptab[(nreg >> 14) & 1], amptab[1] = 0
    (local.set $noiseout (select (i32.const 0) (local.get $amp0) (i32.and (i32.shr_u (global.get $nreg) (i32.const 14)) (i32.const 1))))
    (local.set $nshift (select (i32.const 8) (i32.const 13) (i32.and ${PSG(0xE)} (i32.const 0x80))))
    (local.set $stc ${scale("(global.get $lqtcout)", 2)})
    (local.set $sdmc ${scale("(global.get $rawda)", 4)})
    (local.set $tot ${WL2("(i32.add (i32.add (local.get $stc) (local.get $noiseout)) (local.get $sdmc))")})
    (local.set $nf (i32.shl (i32.load (i32.add (i32.const ${k.NOISETAB}) (i32.shl (i32.and ${PSG(0xE)} (i32.const 0xF)) (i32.const 2)))) (i32.const 17)))
    (local.set $v (local.get $start))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $v) (local.get $end)))
      (call $wave_add (local.get $v) (local.get $tot))
      (if (local.get $inie0)
        (then
          (global.set $lqtriacc (i32.sub (global.get $lqtriacc) (local.get $inie0)))
          (if (i32.le_s (global.get $lqtriacc) (i32.const 0))
            (then
              (block $r0 (loop $rl0
                (global.set $lqtriacc (i32.add (global.get $lqtriacc) (local.get $freq0)))
                (global.set $tristep (i32.and (i32.add (global.get $tristep) (i32.const 1)) (i32.const 0x1F)))
                (br_if $rl0 (i32.le_s (global.get $lqtriacc) (i32.const 0)))))
              (global.set $lqtcout (i32.and (global.get $tristep) (i32.const 0xF)))
              (if (i32.eqz (i32.and (global.get $tristep) (i32.const 0x10)))
                (then (global.set $lqtcout (i32.xor (global.get $lqtcout) (i32.const 0xF)))))
              (global.set $lqtcout (i32.mul (global.get $lqtcout) (i32.const 3)))
              (local.set $stc ${scale("(global.get $lqtcout)", 2)})
              (local.set $tot ${WL2("(i32.add (i32.add (local.get $stc) (local.get $noiseout)) (local.get $sdmc))")})))))
      (if (local.get $inie1)
        (then
          (global.set $lqnoiseacc (i32.sub (global.get $lqnoiseacc) (local.get $inie1)))
          (if (i32.le_s (global.get $lqnoiseacc) (i32.const 0))
            (then
              (block $r1 (loop $rl1
                (global.set $lqnoiseacc (i32.add (global.get $lqnoiseacc) (local.get $nf)))
                (global.set $nreg (i32.and (i32.add (i32.shl (global.get $nreg) (i32.const 1))
                  (i32.and (i32.xor (i32.shr_u (global.get $nreg) (local.get $nshift)) (i32.shr_u (global.get $nreg) (i32.const 14))) (i32.const 1)))
                  (i32.const 0x7FFF)))
                (local.set $noiseout (select (i32.const 0) (local.get $amp0) (i32.and (i32.shr_u (global.get $nreg) (i32.const 14)) (i32.const 1))))
                (br_if $rl1 (i32.le_s (global.get $lqnoiseacc) (i32.const 0)))))
              (local.set $tot ${WL2("(i32.add (i32.add (local.get $stc) (local.get $noiseout)) (local.get $sdmc))")})))))
      (local.set $v (i32.add (local.get $v) (i32.const 1)))
      (br $l))))

  ;; the Do* calls in front of an APU register write (Write_PSG, Write_DMCRegs,
  ;; StatusWrite), and the register state only audio uses
  (func $snd_write (param $a i32) (param $v i32)
    (local $r i32)
    (local.set $r (i32.sub (local.get $a) (i32.const 0x4000)))
    (if (i32.lt_u (local.get $r) (i32.const 8))
      (then
        (call $snd_sq)
${[0, 1].map((x) => `        (if (i32.eq (local.get $r) (i32.const ${x * 4}))
          (then (global.set $envmode${x} (i32.shr_u (i32.and (local.get $v) (i32.const 0x30)) (i32.const 4)))
                (global.set $envspd${x} (i32.and (local.get $v) (i32.const 0xF)))))
        (if (i32.eq (local.get $r) (i32.const ${x * 4 + 1}))
          (then (global.set $sweeprel${x} (i32.const 1)) (global.set $sweepon${x} (i32.and (local.get $v) (i32.const 0x80)))))
        (if (i32.eq (local.get $r) (i32.const ${x * 4 + 2}))
          (then (global.set $curfreq${x} (i32.or (i32.and (global.get $curfreq${x}) (i32.const 0xFF00)) (local.get $v)))))
        (if (i32.eq (local.get $r) (i32.const ${x * 4 + 3}))
          (then ;; SQReload (the length load is in $wr8)
            (global.set $curfreq${x} (i32.or (i32.and (global.get $curfreq${x}) (i32.const 0xFF)) (i32.shl (i32.and (local.get $v) (i32.const 7)) (i32.const 8))))
            (global.set $rdc${x} (i32.const 7))
            (global.set $envrel${x} (i32.const 1))))`).join("\n")}
        (return)))
    (if (i32.eq (local.get $r) (i32.const 0xA)) (then (call $snd_tnp) (return)))
    (if (i32.eq (local.get $r) (i32.const 0xB)) (then (call $snd_tnp) (global.set $trimode (i32.const 1)) (return)))
    (if (i32.eq (local.get $r) (i32.const 0xC))
      (then (call $snd_tnp)
        (global.set $envmode2 (i32.shr_u (i32.and (local.get $v) (i32.const 0x30)) (i32.const 4)))
        (global.set $envspd2 (i32.and (local.get $v) (i32.const 0xF))) (return)))
    (if (i32.eq (local.get $r) (i32.const 0xE)) (then (call $snd_tnp) (return)))
    (if (i32.eq (local.get $r) (i32.const 0xF)) (then (call $snd_tnp) (global.set $envrel2 (i32.const 1)) (return)))
    (if (i32.eq (local.get $r) (i32.const 0x10)) (then (call $snd_tnp) (return)))
    (if (i32.eq (local.get $r) (i32.const 0x11))
      (then (call $snd_tnp) (global.set $rawda (i32.and (local.get $v) (i32.const 0x7F))) (return)))
    (if (i32.eq (local.get $r) (i32.const 0x15)) (then (call $snd_sq) (call $snd_tnp))))

  ;; FrameSoundStuff's audio half: flush first; on even steps the sweep units;
  ;; every step the triangle's linear counter and the three envelopes. (The
  ;; length counters stay in $frame_update, between the flush and this.)
  (func $snd_frame_stuff_pre
    (call $snd_sq) (call $snd_tnp))
  (func $snd_frame_stuff (param $even i32)
    (local $sh i32) (local $mod i32)
    (if (local.get $even)
      (then
${[0, 1].map((P) => `        (if (i32.gt_s (global.get $sweepcnt${P}) (i32.const 0)) (then (global.set $sweepcnt${P} (i32.sub (global.get $sweepcnt${P}) (i32.const 1)))))
        (if (i32.le_s (global.get $sweepcnt${P}) (i32.const 0))
          (then
            (local.set $sh (i32.and ${PSG((P << 2) + 1)} (i32.const 7)))
            (if (i32.and (i32.and (i32.ne (global.get $sweepon${P}) (i32.const 0)) (i32.ne (local.get $sh) (i32.const 0)))
                         (i32.ge_s (global.get $curfreq${P}) (i32.const 8)))
              (then
                (local.set $mod (i32.shr_s (global.get $curfreq${P}) (local.get $sh)))
                (if (i32.and ${PSG((P << 2) + 1)} (i32.const 8))
                  (then (global.set $curfreq${P} (i32.sub (global.get $curfreq${P}) (i32.add (local.get $mod) (i32.const ${P ^ 1})))))
                  (else (if (i32.lt_s (i32.add (local.get $mod) (global.get $curfreq${P})) (i32.const 0x800))
                    (then (global.set $curfreq${P} (i32.add (global.get $curfreq${P}) (local.get $mod)))))))))
            (global.set $sweepcnt${P} (i32.add (i32.and (i32.shr_u ${PSG((P << 2) + 1)} (i32.const 4)) (i32.const 7)) (i32.const 1)))))
        (if (global.get $sweeprel${P})
          (then
            (global.set $sweepcnt${P} (i32.add (i32.and (i32.shr_u ${PSG((P << 2) + 1)} (i32.const 4)) (i32.const 7)) (i32.const 1)))
            (global.set $sweeprel${P} (i32.const 0))))`).join("\n")}))
    ;; linear counter
    (if (global.get $trimode)
      (then (global.set $tricount (i32.and ${PSG(8)} (i32.const 0x7F))))
      (else (if (global.get $tricount) (then (global.set $tricount (i32.sub (global.get $tricount) (i32.const 1)))))))
    (if (i32.eqz (i32.and ${PSG(8)} (i32.const 0x80))) (then (global.set $trimode (i32.const 0))))
${[0, 1, 2].map((P) => `    (block $e${P}
      (if (global.get ${env(P, "rel")})
        (then
          (global.set ${env(P, "vol")} (i32.const 0xF))
          (global.set ${env(P, "cnt")} (i32.and (i32.add (global.get ${env(P, "spd")}) (i32.const 1)) (i32.const 0xFF)))
          (global.set ${env(P, "rel")} (i32.const 0))
          (br $e${P})))
      (if (i32.gt_u (global.get ${env(P, "cnt")}) (i32.const 0)) (then (global.set ${env(P, "cnt")} (i32.sub (global.get ${env(P, "cnt")}) (i32.const 1)))))
      (if (i32.eqz (global.get ${env(P, "cnt")}))
        (then
          (global.set ${env(P, "cnt")} (i32.and (i32.add (global.get ${env(P, "spd")}) (i32.const 1)) (i32.const 0xFF)))
          (if (i32.or (i32.ne (global.get ${env(P, "vol")}) (i32.const 0)) (i32.ne (i32.and (global.get ${env(P, "mode")}) (i32.const 2)) (i32.const 0)))
            (then (global.set ${env(P, "vol")} (i32.and (i32.sub (global.get ${env(P, "vol")}) (i32.const 1)) (i32.const 0xF))))))))`).join("\n")})

  ;; FCEU_SoundCPUHook's DMC output step: RawDALatch +-2 with DoPCM at the
  ;; exact bit time (soundtsoffs += DMCacc around it)
  (func $snd_dmc_step
    (local $bah i32)
    (global.set $ndmcout (i32.add (global.get $ndmcout) (i32.const 1)))
    (local.set $bah (global.get $rawda))
    (global.set $stoffs (i32.add (global.get $stoffs) (global.get $dmcacc)))
    (call $snd_tnp)
    (global.set $stoffs (i32.sub (global.get $stoffs) (global.get $dmcacc)))
    (global.set $rawda (i32.and (i32.add (global.get $rawda)
      (i32.sub (i32.shl (i32.and (global.get $dmcshift) (i32.const 1)) (i32.const 2)) (i32.const 2))) (i32.const 0xFF)))
    (if (i32.and (global.get $rawda) (i32.const 0x80)) (then (global.set $rawda (local.get $bah)))))

  ;; FlushEmulateSound (soundq 0) + SexyFilter + the libretro stereo hand-off
  (func $snd_flush
    (local $end i32) (local $n i32) (local $i i32) (local $cur i32) (local $p i32)
    (local $ino i64) (local $t i64) (local $s i32)
    (if (i32.eqz (i32.sub (global.get $ts) (global.get $sndts0))) (then (return)))
    (call $snd_sq) (call $snd_tnp)
    (local.set $end ${END})
    (local.set $n (i32.shr_s (local.get $end) (i32.const 4)))
    (local.set $cur (i32.load (i32.const ${AUDIO_CURSOR})))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $p (i32.add (i32.const ${k.WAVE}) (i32.shl (local.get $i) (i32.const 2))))
      (local.set $ino (i64.mul (i64.extend_i32_s (i32.load (local.get $p))) (i64.const ${k.vmul})))
      (global.set $sfacc1 (i64.add (global.get $sfacc1)
        (i64.shr_s (i64.mul (i64.sub (local.get $ino) (global.get $sfacc1)) (i64.const ${k.mul1})) (i64.const 16))))
      (global.set $sfacc2 (i64.add (global.get $sfacc2)
        (i64.shr_s (i64.mul (i64.sub (i64.sub (local.get $ino) (global.get $sfacc1)) (global.get $sfacc2)) (i64.const ${k.mul2})) (i64.const 16))))
      (i32.store (local.get $p) (i32.const 0))
      (local.set $t (i64.shr_s (i64.add (i64.sub (global.get $sfacc1) (local.get $ino)) (global.get $sfacc2)) (i64.const 16)))
      ;; (int32_t) then clamp to int16
      (local.set $s (i32.wrap_i64 (local.get $t)))
      (if (i32.gt_s (local.get $s) (i32.const 32767)) (then (local.set $s (i32.const 32767))))
      (if (i32.lt_s (local.get $s) (i32.const -32768)) (then (local.set $s (i32.const -32768))))
      ;; stereo_filter_apply_null: L = R = the mono sample
      (i32.store (i32.add (i32.const ${AUDIO}) (i32.shl (i32.and (local.get $cur) (i32.const ${AUDIO_CAP - 1})) (i32.const 2)))
        (i32.or (i32.and (local.get $s) (i32.const 0xFFFF)) (i32.shl (local.get $s) (i32.const 16))))
      (local.set $cur (i32.and (i32.add (local.get $cur) (i32.const 1)) (i32.const ${AUDIO_CAP - 1})))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store (i32.const ${AUDIO_CURSOR}) (local.get $cur))
    (global.set $sndframes (i32.add (global.get $sndframes) (local.get $n)))
    ;; the partial last sample carries over
    (if (i32.and (local.get $end) (i32.const 0xF))
      (then (i32.store (i32.const ${k.WAVE}) (i32.load (i32.add (i32.const ${k.WAVE}) (i32.shl (local.get $n) (i32.const 2)))))))
    (i32.store (i32.add (i32.const ${k.WAVE}) (i32.shl (local.get $n) (i32.const 2))) (i32.const 0))
    (global.set $cbc0 (i32.and (local.get $end) (i32.const 0xF)))
    (global.set $cbc2 (i32.and (local.get $end) (i32.const 0xF)))
    (global.set $stoffs (i32.shr_u (i32.mul (i32.const ${k.soundtsinc}) (i32.and (local.get $end) (i32.const 0xF))) (i32.const 16)))
    ;; sound_timestamp = 0
    (global.set $sndts0 (global.get $ts)))
`;
}
