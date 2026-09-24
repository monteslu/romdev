// Game Boy APU for the WAT cart, ported from gambatte (the reference core
// romdev verifies GB/GBC recompiles against) so a recompiled cart emits the
// SAME samples as romdev's gambatte-libretro:
//
//   libgambatte/src/sound.cpp           PSG: generateSamples, NR50/NR51, NR52 status
//   libgambatte/src/sound/channel1..4   the four channels and their update loops
//   libgambatte/src/sound/duty_unit, envelope_unit, length_counter
//   libgambatte/src/gambatte-memory.cpp the $FF10-$FF3F read/write rules
//   libgambatte/libretro/blipper.c      the fixed-point band-limited resampler
//                                       gambatte-libretro runs (sinc, 64:1)
//
// gambatte's model, which this follows exactly (NOT the DIV-driven model of
// some other emulators):
//   - Sound runs on its own clock: one native sample per 2 CPU cycles at single
//     speed, per 4 at double speed (PSG::generateSamples shifts by 1 + ds), so
//     ~2 MHz regardless of speed. Each channel keeps a cycleCounter_ in native
//     samples; all four stay equal, so the cart keeps ONE ($apu_cc).
//   - The frame sequencer is that counter: bits 12-14 (length every 2^13
//     samples, sweep 2^14, envelope 2^15). NR52 power-on moves it
//     (Channel::reset). A DIV write does not touch it.
//   - Each channel writes a DELTA where its output changes; gambatte sums them
//     into a 32-bit packed stereo accumulator (PSG::fillBuffer) and blipper
//     turns each step into 32 taps at 1/64 rate. The cart feeds the deltas
//     straight into blipper (it is linear, so per-channel pushes at the same
//     phase add up to the summed push) and never materialises the 2 MHz stream.
//   - Output is gambatte-libretro's: int16 stereo at 32768 Hz (4194304 /
//     70224 * 35112 / 64), left = SO2 (NR51 high nibble, NR50 bits 4-6),
//     right = SO1, read out at every frame hand-off. A libretro dupe frame
//     (no emulation) outputs nothing, as gambatte-libretro's retro_run.
//   - CGB PCM12/PCM34 ($FF76/$FF77): gambatte does not model them (the read
//     returns the power-on I/O byte); the cart's $iostore table already does
//     the same, so they are not the APU's.
//
// Hook points in the rest of the backend (all calls into this file):
//   $apu_init            wc_init, after the power-on I/O image is in place
//   $apu_ffw p v         $iostore, before its register storage ($FF10-$FF3F)
//   $apu_poweroff        $iostore, after NR52-off wrote 0 through $FF10-$FF25
//   $apu_ffr x -> v      $rd8 for $FF26 and $FF30-$FF3F
//   $apu_gen cc          Memory::stop's generateSamples before a speed switch
//   $apu_frame           wc_render at the frame hand-off (gambatte runFor end)
//   $apu_rebase dec      wc_render's 2^31 cycle-counter rebase
//
// Tables (blipper's filter bank, DutyUnit's step tables, the power-on SPU
// state) are generated from gambatte's source by
// scripts/recompile-gen/gen-gb-apu.mjs into apu-tables.json.
//
// Plain JS ESM + JSDoc.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { IOREG } from "./hw-gb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let TABLES = null;
/** @returns {any} apu-tables.json */
export function apuTables() {
  if (!TABLES) TABLES = JSON.parse(readFileSync(path.join(__dirname, "apu-tables.json"), "utf8"));
  return TABLES;
}

/**
 * Linear-memory block of the APU: the hole between the probe's pc ring
 * (ends 0x29000) and the DMG indexed framebuffer (0x30000).
 */
export const APU = 0x29000;
export const APU_END = 0x30000;
/** blipper taps and phases (decimation) */
const TAPS = 32, PHASES = 64;
/** one blipper output buffer: 1024 samples + taps (see $apu_gen's read threshold) */
const BUFN = 1024 + TAPS;
/** gambatte-libretro reads blipper early once this many samples are ready */
const READ_AT = (1024 + 512) >> 1;
/** native samples per $apu_run slice (keeps BUFN sufficient) */
const SLICE = 2048;
export const APU_LAYOUT = Object.freeze({
  wave: APU + 0x00,         // Channel3::waveRam_ (16 bytes)
  writeCursor: APU + 0x10,  // wasmcart audio write cursor (stereo frames, mod RINGCAP)
  guard: APU + 0x14,        // count of generate calls whose cycle counter went backwards (must stay 0)
  frames: APU + 0x18,       // frames that produced audio
  samples: APU + 0x1C,      // total output sample frames written
  mute: APU + 0x80,         // section audio.muteMask: bit i silences channel i+1 (0 at power-on)
  bufL: APU + 0x100,        // blipper output accumulators, int32
  bufR: APU + 0x100 + BUFN * 4,
  filter: APU + 0x2300,     // blipper filter bank, int16 [phase][tap]
  ring: APU + 0x3400,       // wasmcart audio ring: int16 L,R per frame
  ringCap: 2048,
});
{
  const L = APU_LAYOUT;
  if (L.bufR + BUFN * 4 > L.filter || L.filter + TAPS * PHASES * 2 > L.ring || L.ring + L.ringCap * 4 > APU_END) {
    throw new Error("gb apu: layout overflows its block");
  }
}
/** wasmcart audio sample rate the cart declares (gambatte-libretro's blipper rate). */
export const APU_SAMPLE_RATE = 32768;

const DIS = -1; // SoundUnit::counter_disabled (0xFFFFFFFF)
const MAX = 0x80000000 | 0; // SoundUnit::counter_max

const g = (n) => `(global.get $${n})`;
const s = (n, v) => `(global.set $${n} ${v})`;
const c = (v) => `(i32.const ${v | 0})`;
const glob = (names) => names.map((n) => `  (global $${n} (mut i32) (i32.const 0))`).join("\n");

/**
 * DutyUnit (duty_unit.cpp) for channel prefix `p` (c1/c2).
 * @param {string} p
 * @param {any} T tables
 */
function dutyWat(p, T) {
  const d = (n) => `${p}_d${n}`;
  return `
  ;; ---- ${p} DutyUnit ----
  (func $${p}_d_updatepos (param $cc i32) (local $inc i32)
    (if (i32.ge_u (local.get $cc) ${g(d("npu"))})
      (then
        (local.set $inc (i32.add (i32.div_u (i32.sub (local.get $cc) ${g(d("npu"))}) ${g(d("per"))}) (i32.const 1)))
        ${s(d("npu"), `(i32.add ${g(d("npu"))} (i32.mul ${g(d("per"))} (local.get $inc)))`)}
        ${s(d("pos"), `(i32.and (i32.add ${g(d("pos"))} (local.get $inc)) (i32.const 7))`)}
        ${s(d("high"), `(call $apu_outstate ${g(d("duty"))} ${g(d("pos"))})`)})))
  (func $${p}_d_setcounter (local $np i32)
    (if (i32.and (i32.ne ${g(d("ee"))} (i32.const 0)) (i32.ne ${g(d("npu"))} ${c(DIS)}))
      (then
        (local.set $np (i32.and (i32.add ${g(d("pos"))} (i32.const 1)) (i32.const 7)))
        ${s(d("cnt"), g(d("npu")))}
        ${s(d("inc"), `(call $apu_nsd ${g(d("duty"))} (local.get $np))`)}
        (if (i32.eq (call $apu_outstate ${g(d("duty"))} (local.get $np)) ${g(d("high"))})
          (then
            ${s(d("cnt"), `(i32.add ${g(d("cnt"))} (i32.mul ${g(d("per"))} ${g(d("inc"))}))`)}
            ${s(d("inc"), `(call $apu_nsd ${g(d("duty"))} (i32.and (i32.add (local.get $np) ${g(d("inc"))}) (i32.const 7)))`)})))
      (else ${s(d("cnt"), c(DIS))})))
  (func $${p}_d_freq (result i32)
    (i32.sub (i32.const 2048) (i32.shr_u ${g(d("per"))} (i32.const 1))))
  (func $${p}_d_setfreq (param $f i32) (param $cc i32)
    (call $${p}_d_updatepos (local.get $cc))
    ${s(d("per"), `(i32.and (i32.shl (i32.sub (i32.const 2048) (local.get $f)) (i32.const 1)) (i32.const 0xFFFF))`)}
    (call $${p}_d_setcounter))
  (func $${p}_d_event
    ${s(d("high"), `(i32.xor ${g(d("high"))} (i32.const 1))`)}
    ${s(d("cnt"), `(i32.add ${g(d("cnt"))} (i32.mul ${g(d("inc"))} ${g(d("per"))}))`)}
    ${s(d("inc"), `(i32.load8_u (i32.add (i32.const ${APU + 0x40}) (i32.add (i32.shl ${g(d("duty"))} (i32.const 1)) ${g(d("high"))})))`)})
  (func $${p}_d_nr1 (param $v i32) (param $cc i32)
    (call $${p}_d_updatepos (local.get $cc))
    ${s(d("duty"), `(i32.shr_u (local.get $v) (i32.const 6))`)}
    (call $${p}_d_setcounter))
  (func $${p}_d_nr3 (param $v i32) (param $cc i32)
    (call $${p}_d_setfreq (i32.or (i32.and (call $${p}_d_freq) (i32.const 0x700)) (local.get $v)) (local.get $cc)))
  (func $${p}_d_nr4 (param $v i32) (param $cc i32)
    (call $${p}_d_setfreq (i32.or (i32.and (i32.shl (local.get $v) (i32.const 8)) (i32.const 0x700))
                                  (i32.and (call $${p}_d_freq) (i32.const 0xFF))) (local.get $cc))
    (if (i32.and (local.get $v) (i32.const 0x80))
      (then
        ${s(d("npu"), `(i32.add (i32.add (i32.and (local.get $cc) (i32.const -2)) ${g(d("per"))}) (i32.const 4))`)}
        (call $${p}_d_setcounter))))
  (func $${p}_d_reset
    ${s(d("pos"), c(0))} ${s(d("high"), c(0))} ${s(d("npu"), c(DIS))}
    (call $${p}_d_setcounter))
  (func $${p}_d_rebase (param $old i32)
    (if (i32.eq ${g(d("npu"))} ${c(DIS)}) (then (return)))
    (call $${p}_d_updatepos (local.get $old))
    ${s(d("npu"), `(i32.sub ${g(d("npu"))} ${c(MAX)})`)}
    (call $${p}_d_setcounter))
  (func $${p}_d_kill ${s(d("ee"), c(0))} (call $${p}_d_setcounter))
  (func $${p}_d_revive (param $cc i32)
    (call $${p}_d_updatepos (local.get $cc))
    ${s(d("ee"), c(1))}
    (call $${p}_d_setcounter))
`;
}

/**
 * EnvelopeUnit (envelope_unit.cpp) for prefix `p`; `onoff` is the channel's
 * static output test (VolOnOffEvent), called with the event's cycle.
 * @param {string} p
 */
function envWat(p) {
  const e = (n) => `${p}_e${n}`;
  return `
  ;; ---- ${p} EnvelopeUnit ----
  (func $${p}_e_event (local $per i32) (local $nv i32)
    (local.set $per (i32.and ${g(e("nr2"))} (i32.const 7)))
    (if (local.get $per)
      (then
        (local.set $nv (if (result i32) (i32.and ${g(e("nr2"))} (i32.const 8))
          (then (i32.add ${g(e("vol"))} (i32.const 1))) (else (i32.sub ${g(e("vol"))} (i32.const 1)))))
        (if (i32.lt_u (local.get $nv) (i32.const 0x10))
          (then
            ${s(e("vol"), "(local.get $nv)")}
            (if (i32.lt_u ${g(e("vol"))} (i32.const 2)) (then (call $${p}_static ${g(e("cnt"))})))
            ${s(e("cnt"), `(i32.add ${g(e("cnt"))} (i32.shl (local.get $per) (i32.const 15)))`)})
          (else ${s(e("cnt"), c(DIS))})))
      (else ${s(e("cnt"), `(i32.add ${g(e("cnt"))} (i32.const ${8 << 15}))`)})))
  ;; nr2Change: returns 1 when the DAC is now off
  (func $${p}_e_nr2 (param $v i32) (result i32)
    (if (i32.and (i32.eqz (i32.and ${g(e("nr2"))} (i32.const 7))) (i32.ne ${g(e("cnt"))} ${c(DIS)}))
      (then ${s(e("vol"), `(i32.add ${g(e("vol"))} (i32.const 1))`)})
      (else (if (i32.eqz (i32.and ${g(e("nr2"))} (i32.const 8)))
        (then ${s(e("vol"), `(i32.add ${g(e("vol"))} (i32.const 2))`)}))))
    (if (i32.and (i32.xor ${g(e("nr2"))} (local.get $v)) (i32.const 8))
      (then ${s(e("vol"), `(i32.sub (i32.const 0x10) ${g(e("vol"))})`)}))
    ${s(e("vol"), `(i32.and ${g(e("vol"))} (i32.const 0xF))`)}
    ${s(e("nr2"), "(local.get $v)")}
    (i32.eqz (i32.and (local.get $v) (i32.const 0xF8))))
  ;; nr4Init: returns 1 when the DAC is off
  (func $${p}_e_init (param $cc i32) (result i32) (local $per i32)
    (local.set $per (if (result i32) (i32.and ${g(e("nr2"))} (i32.const 7))
      (then (i32.and ${g(e("nr2"))} (i32.const 7))) (else (i32.const 8))))
    (if (i32.eqz (i32.and (i32.add (local.get $cc) (i32.const 2)) (i32.const 0x7000)))
      (then (local.set $per (i32.add (local.get $per) (i32.const 1)))))
    ${s(e("cnt"), `(i32.add (i32.sub (local.get $cc) (i32.and (i32.sub (local.get $cc) (i32.const 0x1000)) (i32.const 0x7FFF)))
                          (i32.mul (local.get $per) (i32.const 0x8000)))`)}
    ${s(e("vol"), `(i32.shr_u ${g(e("nr2"))} (i32.const 4))`)}
    (i32.eqz (i32.and ${g(e("nr2"))} (i32.const 0xF8))))
`;
}

/**
 * LengthCounter (length_counter.cpp) for prefix `p`; `$<p>_disable` is the
 * channel's MasterDisabler.
 * @param {string} p
 * @param {number} mask
 */
function lenWat(p, mask) {
  const l = (n) => `${p}_l${n}`;
  return `
  ;; ---- ${p} LengthCounter (mask $${mask.toString(16)}) ----
  (func $${p}_l_event
    ${s(l("cnt"), c(DIS))} ${s(l("len"), c(0))}
    (call $${p}_disable))
  (func $${p}_l_nr1 (param $v i32) (param $nr4 i32) (param $cc i32)
    ${s(l("len"), `(i32.add (i32.and (i32.xor (local.get $v) (i32.const -1)) (i32.const ${mask})) (i32.const 1))`)}
    ${s(l("cnt"), `(if (result i32) (i32.and (local.get $nr4) (i32.const 0x40))
      (then (i32.shl (i32.add (i32.shr_u (local.get $cc) (i32.const 13)) ${g(l("len"))}) (i32.const 13)))
      (else ${c(DIS)}))`)})
  (func $${p}_l_nr4 (param $old i32) (param $v i32) (param $cc i32) (local $dec i32)
    (if (i32.ne ${g(l("cnt"))} ${c(DIS)})
      (then ${s(l("len"), `(i32.and (i32.sub (i32.shr_u ${g(l("cnt"))} (i32.const 13)) (i32.shr_u (local.get $cc) (i32.const 13))) (i32.const 0xFFFF))`)}))
    (if (i32.and (local.get $v) (i32.const 0x40))
      (then
        (local.set $dec (i32.and (i32.shr_u (i32.xor (local.get $cc) (i32.const -1)) (i32.const 12)) (i32.const 1)))
        (if (i32.and (i32.eqz (i32.and (local.get $old) (i32.const 0x40))) (i32.ne ${g(l("len"))} (i32.const 0)))
          (then
            ${s(l("len"), `(i32.and (i32.sub ${g(l("len"))} (local.get $dec)) (i32.const 0xFFFF))`)}
            (if (i32.eqz ${g(l("len"))}) (then (call $${p}_disable)))))))
    (if (i32.and (i32.ne (i32.and (local.get $v) (i32.const 0x80)) (i32.const 0)) (i32.eqz ${g(l("len"))}))
      (then ${s(l("len"), `(i32.sub (i32.const ${mask + 1}) (local.get $dec))`)}))
    ${s(l("cnt"), `(if (result i32) (i32.and (i32.ne (i32.and (local.get $v) (i32.const 0x40)) (i32.const 0)) (i32.ne ${g(l("len"))} (i32.const 0)))
      (then (i32.shl (i32.add (i32.shr_u (local.get $cc) (i32.const 13)) ${g(l("len"))}) (i32.const 13)))
      (else ${c(DIS)}))`)})
`;
}

/**
 * Verification only: the section's muteMask byte silences a channel by
 * giving it a zero output base (its counters keep running).
 * @param {string} p
 */
const muted = (p) => `(if (i32.and (i32.load8_u (i32.const ${APU_LAYOUT.mute})) (i32.const ${1 << (Number(p[1]) - 1)})) (then (local.set $bl (i32.const 0)) (local.set $br (i32.const 0))))`;

/** Channel names in muteMask bit order. */
export const APU_MUTE_CHANNELS = ["ch1", "ch2", "ch3", "ch4"];

/** SoundUnit::resetCounters for a plain counter global. */
const rebaseCnt = (n) => `(if (i32.ne ${g(n)} ${c(DIS)}) (then ${s(n, `(i32.sub ${g(n)} ${c(MAX)})`)}))`;

/**
 * Emit a channel output value at native-sample offset `pos` of the current
 * slice: the delta against the channel's previous output goes to blipper.
 * @param {string} p
 * @param {string} k   WAT i32: the channel's level factor (2v-15 or -15)
 * @param {string} pos WAT i32
 */
const emit = (p, k, pos) => `(call $apu_emit (i32.mul (local.get $bl) ${k}) (i32.mul (local.get $br) ${k}) ${pos} (i32.const ${APU + 0x20 + 8 * Number(p[1]) - 8}))`;

/**
 * A pulse/noise channel's update() (channel1/2/4.cpp): runs `n` native samples
 * from the slice start. `wave` names the waveform unit (duty or lfsr).
 * @param {string} p
 * @param {{sweep?:boolean, noise?:boolean}} o
 */
function squareUpdateWat(p, o) {
  const cnt = o.noise ? g(`${p}_fcnt`) : g(`${p}_dcnt`);
  const high = o.noise ? `(i32.xor (i32.and ${g(`${p}_freg`)} (i32.const 1)) (i32.const 1))` : g(`${p}_dhigh`);
  const wevent = o.noise ? `(call $${p}_f_event)` : `(call $${p}_d_event)`;
  const nextCnt = o.sweep
    ? `(if (result i32) (i32.eqz ${g(`${p}_nev`)}) (then ${g(`${p}_scnt`)}) (else (if (result i32) (i32.eq ${g(`${p}_nev`)} (i32.const 1)) (then ${g(`${p}_ecnt`)}) (else ${g(`${p}_lcnt`)}))))`
    : `(if (result i32) (i32.eq ${g(`${p}_nev`)} (i32.const 1)) (then ${g(`${p}_ecnt`)}) (else ${g(`${p}_lcnt`)}))`;
  const nextEvent = o.sweep
    ? `(if (i32.eqz ${g(`${p}_nev`)}) (then (call $${p}_s_event)) (else (if (i32.eq ${g(`${p}_nev`)} (i32.const 1)) (then (call $${p}_e_event)) (else (call $${p}_l_event)))))`
    : `(if (i32.eq ${g(`${p}_nev`)} (i32.const 1)) (then (call $${p}_e_event)) (else (call $${p}_l_event)))`;
  // outHigh: channel 4 does not look at master_ (channel4.cpp update)
  const hk = o.noise
    ? `(i32.sub (i32.shl ${g(`${p}_evol`)} (i32.const 1)) (i32.const 15))`
    : `(if (result i32) ${g(`${p}_master`)} (then (i32.sub (i32.shl ${g(`${p}_evol`)} (i32.const 1)) (i32.const 15))) (else (i32.const -15)))`;
  return `
  (func $${p}_update (param $n i32)
    (local $cc i32) (local $end i32) (local $nme i32) (local $hk i32) (local $k i32) (local $bl i32) (local $br i32)
    ;; outBase = dacIsOn ? soBaseVol & soMask : 0, per side
    (if (i32.and ${g(`${p}_enr2`)} (i32.const 0xF8))
      (then
        (if ${g(`${p}_sol`)} (then (local.set $bl ${g("apu_vl")})))
        (if ${g(`${p}_sor`)} (then (local.set $br ${g("apu_vr")})))))
    ${muted(p)}
    (local.set $cc ${g("apu_s0")})
    (local.set $end (i32.add (local.get $cc) (local.get $n)))
    (block $done (loop $major
      (local.set $hk ${hk})
      (local.set $nme ${nextCnt})
      (if (i32.gt_u (local.get $nme) (local.get $end)) (then (local.set $nme (local.get $end))))
      (local.set $k (if (result i32) ${high} (then (local.get $hk)) (else (i32.const -15))))
      (block $wd (loop $wl
        (br_if $wd (i32.gt_u ${cnt} (local.get $nme)))
        ${emit(p, "(local.get $k)", `(i32.sub (local.get $cc) ${g("apu_s0")})`)}
        (local.set $cc ${cnt})
        ${wevent}
        (local.set $k (if (result i32) ${high} (then (local.get $hk)) (else (i32.const -15))))
        (br $wl)))
      (if (i32.lt_u (local.get $cc) (local.get $nme))
        (then
          ${emit(p, "(local.get $k)", `(i32.sub (local.get $cc) ${g("apu_s0")})`)}
          (local.set $cc (local.get $nme))))
      (br_if $done (i32.ne ${nextCnt} (local.get $nme)))
      ${nextEvent}
      (call $${p}_setevent)
      (br $major))))
`;
}

/**
 * The whole APU: globals, tables, channels, PSG, blipper, memory hooks.
 * @param {{cgb:boolean, muteChannels?:Array<string|number>}} o  muteChannels presets
 *   the muteMask (a must-fail control build, not a faithful cart)
 * @returns {string} WAT module fields
 */
export function apuWat(o) {
  const T = apuTables();
  const cgb = !!o.cgb;
  const IS = cgb ? T.initstate.cgb : T.initstate.dmg;
  const L = APU_LAYOUT;
  const cc = "(i32.add (global.get $abscc) (call $ioff))"; // the access cycle
  const names = ["apu_cc", "apu_last", "apu_en", "apu_vl", "apu_vr", "apu_s0", "apu_bph", "apu_il", "apu_ir"];
  for (const p of ["c1", "c2"]) {
    names.push(`${p}_master`, `${p}_nr4`, `${p}_sol`, `${p}_sor`, `${p}_nev`,
      `${p}_dcnt`, `${p}_dnpu`, `${p}_dper`, `${p}_dpos`, `${p}_dduty`, `${p}_dinc`, `${p}_dhigh`, `${p}_dee`,
      `${p}_ecnt`, `${p}_enr2`, `${p}_evol`, `${p}_lcnt`, `${p}_llen`);
  }
  names.push("c1_scnt", "c1_sshadow", "c1_snr0", "c1_sneg");
  names.push("c3_master", "c3_nr0", "c3_nr3", "c3_nr4", "c3_sol", "c3_sor", "c3_wcnt", "c3_lrt", "c3_wpos",
    "c3_rshift", "c3_sbuf", "c3_lcnt", "c3_llen");
  names.push("c4_master", "c4_nr4", "c4_sol", "c4_sor", "c4_nev", "c4_fcnt", "c4_fbak", "c4_freg", "c4_fnr3", "c4_fmaster",
    "c4_ecnt", "c4_enr2", "c4_evol", "c4_lcnt", "c4_llen");

  // duty tables: nextStateDistance at +0x60 (32 bytes), inc at +0x40 (8 bytes)
  const bytes = (arr) => arr.map((b) => "\\" + (b & 0xFF).toString(16).padStart(2, "0")).join("");
  const filterHex = T.blipper.filterBank.replace(/../g, "\\$&");

  // blipper push: 32 taps unrolled
  let taps = "";
  for (let i = 0; i < TAPS; i++) {
    taps += `\n    (i32.store offset=${i * 4} (local.get $o) (i32.add (i32.load offset=${i * 4} (local.get $o)) (i32.mul (local.get $d) (i32.load16_s offset=${i * 2} (local.get $f)))))`;
  }

  let mute = 0;
  for (const ch of o.muteChannels ?? []) {
    const i = typeof ch === "number" ? ch - 1 : APU_MUTE_CHANNELS.indexOf(String(ch));
    if (!(i >= 0 && i < 4)) throw new Error(`gb apu: muteChannels entry ${JSON.stringify(ch)} is not one of ${APU_MUTE_CHANNELS.join(", ")} (or 1-4)`);
    mute |= 1 << i;
  }
  return `
  ;; ================= APU (gambatte sound.cpp + blipper.c) =================
${glob(names)}
  ${mute ? `(data (i32.const ${L.mute}) "\\${mute.toString(16).padStart(2, "0")}")` : ""}
  (data (i32.const ${APU + 0x40}) "${bytes(T.duty.inc)}")
  (data (i32.const ${APU + 0x60}) "${bytes(T.duty.nextStateDistance)}")
  (data (i32.const ${L.filter}) "${filterHex}")

  (func $apu_outstate (param $duty i32) (param $pos i32) (result i32)
    (i32.and (i32.shr_u (i32.const ${T.duty.outStates}) (i32.add (i32.shl (local.get $duty) (i32.const 3)) (local.get $pos))) (i32.const 1)))
  (func $apu_nsd (param $duty i32) (param $pos i32) (result i32)
    (i32.load8_u (i32.add (i32.const ${APU + 0x60}) (i32.add (i32.shl (local.get $duty) (i32.const 3)) (local.get $pos)))))

  ;; ---- blipper_push_delta, left (side 0) and right (side 1) ----
  ;; phase of native sample \`pos\` of this slice = bph + pos + 1 (blipper
  ;; advances clocks_skip + 1 before pushing the change at that sample)
  (func $apu_push (param $buf i32) (param $d i32) (param $pos i32)
    (local $p i32) (local $t i32) (local $f i32) (local $o i32)
    (local.set $p (i32.add (i32.add ${g("apu_bph")} (local.get $pos)) (i32.const 1)))
    (local.set $t (i32.shr_u (i32.add (local.get $p) (i32.const ${PHASES - 1})) (i32.const 6)))
    (local.set $f (i32.add (i32.const ${L.filter})
      (i32.shl (i32.sub (i32.shl (local.get $t) (i32.const 6)) (local.get $p)) (i32.const 6))))
    (local.set $o (i32.add (local.get $buf) (i32.shl (local.get $t) (i32.const 2))))${taps})
  ;; a channel's output at slice offset $pos: prevOut_ lives at $prev (L, R)
  (func $apu_emit (param $ol i32) (param $or i32) (param $pos i32) (param $prev i32)
    (local $d i32)
    (local.set $d (i32.sub (local.get $ol) (i32.load (local.get $prev))))
    (if (local.get $d) (then (call $apu_push (i32.const ${L.bufL}) (local.get $d) (local.get $pos))))
    (i32.store (local.get $prev) (local.get $ol))
    (local.set $d (i32.sub (local.get $or) (i32.load offset=4 (local.get $prev))))
    (if (local.get $d) (then (call $apu_push (i32.const ${L.bufR}) (local.get $d) (local.get $pos))))
    (i32.store offset=4 (local.get $prev) (local.get $or)))

  ;; ---- blipper_read (fixed point) into the wasmcart ring, both sides ----
  (func $apu_read
    (local $n i32) (local $i i32) (local $sl i32) (local $sr i32) (local $q i32) (local $w i32) (local $a i32)
    (local.set $n (i32.shr_u (i32.add ${g("apu_bph")} (i32.const ${PHASES - 1})) (i32.const 6)))
    (if (i32.eqz (local.get $n)) (then (return)))
    (local.set $sl ${g("apu_il")}) (local.set $sr ${g("apu_ir")})
    (local.set $w (i32.load (i32.const ${L.writeCursor})))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $a (i32.add (i32.const ${L.ring}) (i32.shl (local.get $w) (i32.const 2))))
      ;; left
      (local.set $sl (i32.add (local.get $sl)
        (i32.sub (i32.shr_s (i32.load (i32.add (i32.const ${L.bufL}) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 1))
                 (i32.shr_s (local.get $sl) (i32.const 9)))))
      (local.set $q (i32.shr_s (i32.add (local.get $sl) (i32.const 0x4000)) (i32.const 15)))
      (if (i32.ne (i32.extend16_s (local.get $q)) (local.get $q))
        (then
          (local.set $q (i32.xor (i32.shr_s (local.get $q) (i32.const 16)) (i32.const 0x7FFF)))
          (local.set $sl (i32.shl (local.get $q) (i32.const 15)))))
      (i32.store16 (local.get $a) (local.get $q))
      ;; right
      (local.set $sr (i32.add (local.get $sr)
        (i32.sub (i32.shr_s (i32.load (i32.add (i32.const ${L.bufR}) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 1))
                 (i32.shr_s (local.get $sr) (i32.const 9)))))
      (local.set $q (i32.shr_s (i32.add (local.get $sr) (i32.const 0x4000)) (i32.const 15)))
      (if (i32.ne (i32.extend16_s (local.get $q)) (local.get $q))
        (then
          (local.set $q (i32.xor (i32.shr_s (local.get $q) (i32.const 16)) (i32.const 0x7FFF)))
          (local.set $sr (i32.shl (local.get $q) (i32.const 15)))))
      (i32.store16 offset=2 (local.get $a) (local.get $q))
      (local.set $w (i32.and (i32.add (local.get $w) (i32.const 1)) (i32.const ${L.ringCap - 1})))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store (i32.const ${L.writeCursor}) (local.get $w))
    (i32.store (i32.const ${L.samples}) (i32.add (i32.load (i32.const ${L.samples})) (local.get $n)))
    ${s("apu_il", "(local.get $sl)")} ${s("apu_ir", "(local.get $sr)")}
    ;; memmove(buf, buf + n, taps); memset(buf + taps, 0, n)
    (memory.copy (i32.const ${L.bufL}) (i32.add (i32.const ${L.bufL}) (i32.shl (local.get $n) (i32.const 2))) (i32.const ${TAPS * 4}))
    (memory.fill (i32.const ${L.bufL + TAPS * 4}) (i32.const 0) (i32.shl (local.get $n) (i32.const 2)))
    (memory.copy (i32.const ${L.bufR}) (i32.add (i32.const ${L.bufR}) (i32.shl (local.get $n) (i32.const 2))) (i32.const ${TAPS * 4}))
    (memory.fill (i32.const ${L.bufR + TAPS * 4}) (i32.const 0) (i32.shl (local.get $n) (i32.const 2)))
    ${s("apu_bph", `(i32.sub ${g("apu_bph")} (i32.shl (local.get $n) (i32.const 6)))`)})

  ;; ================= channel 1 (channel1.cpp) =================
${dutyWat("c1", T)}${envWat("c1")}${lenWat("c1", 0x3F)}
  ;; DutyMasterDisabler
  (func $c1_disable ${s("c1_master", c(0))} (call $c1_d_kill))
  ;; StaticOutputTester<Channel1, DutyUnit>
  (func $c1_static (param $cc i32)
    (if (i32.and (i32.and (i32.or ${g("c1_sol")} ${g("c1_sor")}) (i32.ne ${g("c1_master")} (i32.const 0)))
                 (i32.ne ${g("c1_evol")} (i32.const 0)))
      (then (call $c1_d_revive (local.get $cc))) (else (call $c1_d_kill))))
  (func $c1_setevent
    ${s("c1_nev", c(0))}
    (if (i32.lt_u ${g("c1_ecnt")} ${g("c1_scnt")}) (then ${s("c1_nev", c(1))}))
    (if (i32.lt_u ${g("c1_lcnt")} (if (result i32) (i32.eqz ${g("c1_nev")}) (then ${g("c1_scnt")}) (else ${g("c1_ecnt")})))
      (then ${s("c1_nev", c(2))})))
  ;; ---- SweepUnit ----
  (func $c1_s_calc (result i32) (local $f i32)
    (local.set $f (i32.shr_u ${g("c1_sshadow")} (i32.and ${g("c1_snr0")} (i32.const 7))))
    (if (i32.and ${g("c1_snr0")} (i32.const 8))
      (then (local.set $f (i32.sub ${g("c1_sshadow")} (local.get $f))) ${s("c1_sneg", c(1))})
      (else (local.set $f (i32.add ${g("c1_sshadow")} (local.get $f)))))
    (if (i32.and (local.get $f) (i32.const 2048)) (then (call $c1_disable)))
    (local.get $f))
  (func $c1_s_event (local $per i32) (local $f i32)
    (local.set $per (i32.and (i32.shr_u ${g("c1_snr0")} (i32.const 4)) (i32.const 7)))
    (if (local.get $per)
      (then
        (local.set $f (call $c1_s_calc))
        (if (i32.and (i32.eqz (i32.and (local.get $f) (i32.const 2048))) (i32.ne (i32.and ${g("c1_snr0")} (i32.const 7)) (i32.const 0)))
          (then
            ${s("c1_sshadow", "(i32.and (local.get $f) (i32.const 0xFFFF))")}
            (call $c1_d_setfreq (local.get $f) ${g("c1_scnt")})
            (drop (call $c1_s_calc))))
        ${s("c1_scnt", `(i32.add ${g("c1_scnt")} (i32.shl (local.get $per) (i32.const 14)))`)})
      (else ${s("c1_scnt", `(i32.add ${g("c1_scnt")} (i32.const ${8 << 14}))`)})))
  (func $c1_s_nr0 (param $v i32)
    (if (i32.and (i32.ne ${g("c1_sneg")} (i32.const 0)) (i32.eqz (i32.and (local.get $v) (i32.const 8))))
      (then (call $c1_disable)))
    ${s("c1_snr0", "(local.get $v)")})
  (func $c1_s_init (param $cc i32) (local $per i32) (local $sh i32)
    ${s("c1_sneg", c(0))}
    ${s("c1_sshadow", "(call $c1_d_freq)")}
    (local.set $per (i32.and (i32.shr_u ${g("c1_snr0")} (i32.const 4)) (i32.const 7)))
    (local.set $sh (i32.and ${g("c1_snr0")} (i32.const 7)))
    (if (i32.or (local.get $per) (local.get $sh))
      (then ${s("c1_scnt", `(i32.add (i32.shl (i32.add (i32.shr_u (i32.add (local.get $cc) (i32.const ${2 + (cgb ? 2 : 0)})) (i32.const 14))
                                                  (if (result i32) (local.get $per) (then (local.get $per)) (else (i32.const 8))))
                                         (i32.const 14)) (i32.const 2))`)})
      (else ${s("c1_scnt", c(DIS))}))
    (if (local.get $sh) (then (drop (call $c1_s_calc)))))
  ;; ---- Channel1 register writes (cc = the channel's cycleCounter_) ----
  (func $c1_nr0 (param $v i32) (call $c1_s_nr0 (local.get $v)) (call $c1_setevent))
  (func $c1_nr1 (param $v i32)
    (call $c1_l_nr1 (local.get $v) ${g("c1_nr4")} ${g("apu_cc")})
    (call $c1_d_nr1 (local.get $v) ${g("apu_cc")})
    (call $c1_setevent))
  (func $c1_nr2 (param $v i32)
    (if (call $c1_e_nr2 (local.get $v)) (then (call $c1_disable)) (else (call $c1_static ${g("apu_cc")})))
    (call $c1_setevent))
  (func $c1_nr3 (param $v i32) (call $c1_d_nr3 (local.get $v) ${g("apu_cc")}) (call $c1_setevent))
  (func $c1_nr4w (param $v i32)
    (call $c1_l_nr4 ${g("c1_nr4")} (local.get $v) ${g("apu_cc")})
    ${s("c1_nr4", "(local.get $v)")}
    (call $c1_d_nr4 (local.get $v) ${g("apu_cc")})
    (if (i32.and (local.get $v) (i32.const 0x80))
      (then
        ${s("c1_nr4", `(i32.and ${g("c1_nr4")} (i32.const 0x7F))`)}
        ${s("c1_master", `(i32.eqz (call $c1_e_init ${g("apu_cc")}))`)}
        (call $c1_s_init ${g("apu_cc")})
        (call $c1_static ${g("apu_cc")})))
    (call $c1_setevent))
  (func $c1_setso (param $l i32) (param $r i32)
    ${s("c1_sol", "(local.get $l)")} ${s("c1_sor", "(local.get $r)")}
    (call $c1_static ${g("apu_cc")})
    (call $c1_setevent))
${squareUpdateWat("c1", { sweep: true })}

  ;; ================= channel 2 (channel2.cpp) =================
${dutyWat("c2", T)}${envWat("c2")}${lenWat("c2", 0x3F)}
  (func $c2_disable ${s("c2_master", c(0))} (call $c2_d_kill))
  (func $c2_static (param $cc i32)
    (if (i32.and (i32.and (i32.or ${g("c2_sol")} ${g("c2_sor")}) (i32.ne ${g("c2_master")} (i32.const 0)))
                 (i32.ne ${g("c2_evol")} (i32.const 0)))
      (then (call $c2_d_revive (local.get $cc))) (else (call $c2_d_kill))))
  (func $c2_setevent
    ${s("c2_nev", c(1))}
    (if (i32.lt_u ${g("c2_lcnt")} ${g("c2_ecnt")}) (then ${s("c2_nev", c(2))})))
  (func $c2_nr1 (param $v i32)
    (call $c2_l_nr1 (local.get $v) ${g("c2_nr4")} ${g("apu_cc")})
    (call $c2_d_nr1 (local.get $v) ${g("apu_cc")})
    (call $c2_setevent))
  (func $c2_nr2 (param $v i32)
    (if (call $c2_e_nr2 (local.get $v)) (then (call $c2_disable)) (else (call $c2_static ${g("apu_cc")})))
    (call $c2_setevent))
  (func $c2_nr3 (param $v i32) (call $c2_d_nr3 (local.get $v) ${g("apu_cc")}) (call $c2_setevent))
  ;; channel 2 applies the duty unit's nr4Change AFTER the trigger
  (func $c2_nr4w (param $v i32)
    (call $c2_l_nr4 ${g("c2_nr4")} (local.get $v) ${g("apu_cc")})
    ${s("c2_nr4", "(local.get $v)")}
    (if (i32.and (local.get $v) (i32.const 0x80))
      (then
        ${s("c2_nr4", `(i32.and ${g("c2_nr4")} (i32.const 0x7F))`)}
        ${s("c2_master", `(i32.eqz (call $c2_e_init ${g("apu_cc")}))`)}
        (call $c2_static ${g("apu_cc")})))
    (call $c2_d_nr4 (local.get $v) ${g("apu_cc")})
    (call $c2_setevent))
  (func $c2_setso (param $l i32) (param $r i32)
    ${s("c2_sol", "(local.get $l)")} ${s("c2_sor", "(local.get $r)")}
    (call $c2_static ${g("apu_cc")})
    (call $c2_setevent))
${squareUpdateWat("c2", {})}

  ;; ================= channel 3 (channel3.cpp) =================
${lenWat("c3", 0xFF)}
  ;; Ch3MasterDisabler
  (func $c3_disable ${s("c3_master", c(0))} ${s("c3_wcnt", c(DIS))})
  (func $c3_period (param $nr3 i32) (param $nr4 i32) (result i32)
    (i32.sub (i32.const 0x800) (i32.or (i32.and (i32.shl (local.get $nr4) (i32.const 8)) (i32.const 0x700)) (local.get $nr3))))
  (func $c3_nr0 (param $v i32)
    ${s("c3_nr0", "(i32.and (local.get $v) (i32.const 0x80))")}
    (if (i32.eqz (i32.and (local.get $v) (i32.const 0x80))) (then (call $c3_disable))))
  (func $c3_nr1 (param $v i32) (call $c3_l_nr1 (local.get $v) ${g("c3_nr4")} ${g("apu_cc")}))
  (func $c3_nr2 (param $v i32)
    ${s("c3_rshift", "(i32.and (i32.sub (i32.and (i32.shr_u (local.get $v) (i32.const 5)) (i32.const 3)) (i32.const 1)) (i32.const 0xFF))")}
    (if (i32.gt_u ${g("c3_rshift")} (i32.const 3)) (then ${s("c3_rshift", c(4))})))
  (func $c3_nr4w (param $v i32) (local $pos i32)
    (call $c3_l_nr4 ${g("c3_nr4")} (local.get $v) ${g("apu_cc")})
    ${s("c3_nr4", "(i32.and (local.get $v) (i32.const 0x7F))")}
    (if (i32.and (local.get $v) ${g("c3_nr0")})
      (then
        ${cgb ? "" : `(if (i32.eq ${g("c3_wcnt")} (i32.add ${g("apu_cc")} (i32.const 1)))
          (then
            (local.set $pos (i32.shr_u (i32.and (i32.add ${g("c3_wpos")} (i32.const 1)) (i32.const 0x1F)) (i32.const 1)))
            (if (i32.lt_u (local.get $pos) (i32.const 4))
              (then (i32.store8 (i32.const ${L.wave}) (i32.load8_u (i32.add (i32.const ${L.wave}) (local.get $pos)))))
              (else (i32.store (i32.const ${L.wave}) (i32.load (i32.add (i32.const ${L.wave}) (i32.and (local.get $pos) (i32.const -4)))))))))`}
        ${s("c3_master", c(1))}
        ${s("c3_wpos", c(0))}
        ${s("c3_wcnt", `(i32.add (i32.add ${g("apu_cc")} (call $c3_period ${g("c3_nr3")} (local.get $v))) (i32.const 3))`)}
        ${s("c3_lrt", g("c3_wcnt"))})))
  (func $c3_setso (param $l i32) (param $r i32) ${s("c3_sol", "(local.get $l)")} ${s("c3_sor", "(local.get $r)")})
  (func $c3_waveread (param $i i32) (result i32)
    (if ${g("c3_master")}
      (then
        ${cgb ? "" : `(if (i32.ne ${g("apu_cc")} ${g("c3_lrt")}) (then (return (i32.const 0xFF))))`}
        (local.set $i (i32.shr_u ${g("c3_wpos")} (i32.const 1)))))
    (i32.load8_u (i32.add (i32.const ${L.wave}) (local.get $i))))
  (func $c3_wavewrite (param $i i32) (param $v i32)
    (if ${g("c3_master")}
      (then
        ${cgb ? "" : `(if (i32.ne ${g("apu_cc")} ${g("c3_lrt")}) (then (return)))`}
        (local.set $i (i32.shr_u ${g("c3_wpos")} (i32.const 1)))))
    (i32.store8 (i32.add (i32.const ${L.wave}) (local.get $i)) (local.get $v)))
  (func $c3_sample (result i32)
    (i32.load8_u (i32.add (i32.const ${L.wave}) (i32.shr_u ${g("c3_wpos")} (i32.const 1)))))
  (func $c3_updwave (param $cc i32) (local $per i32) (local $n i32)
    (if (i32.ge_u (local.get $cc) ${g("c3_wcnt")})
      (then
        (local.set $per (call $c3_period ${g("c3_nr3")} ${g("c3_nr4")}))
        (local.set $n (i32.div_u (i32.sub (local.get $cc) ${g("c3_wcnt")}) (local.get $per)))
        ${s("c3_lrt", `(i32.add ${g("c3_wcnt")} (i32.mul (local.get $n) (local.get $per)))`)}
        ${s("c3_wcnt", `(i32.add ${g("c3_lrt")} (local.get $per))`)}
        ${s("c3_wpos", `(i32.and (i32.add ${g("c3_wpos")} (i32.add (local.get $n) (i32.const 1))) (i32.const 0x1F))`)}
        ${s("c3_sbuf", "(call $c3_sample)")})))
  ;; ((sampleBuf >> (~wavePos << 2 & 4) & 0xF) >> rshift) * 2 - 15
  (func $c3_level (result i32)
    (i32.sub (i32.shl (i32.shr_u (i32.and (i32.shr_u ${g("c3_sbuf")}
                                   (i32.and (i32.shl (i32.xor ${g("c3_wpos")} (i32.const -1)) (i32.const 2)) (i32.const 4)))
                                 (i32.const 0xF)) ${g("c3_rshift")})
                      (i32.const 1)) (i32.const 15)))
  (func $c3_update (param $n i32)
    (local $cc i32) (local $end i32) (local $nme i32) (local $k i32) (local $bl i32) (local $br i32)
    (if ${g("c3_nr0")}
      (then
        (if ${g("c3_sol")} (then (local.set $bl ${g("apu_vl")})))
        (if ${g("c3_sor")} (then (local.set $br ${g("apu_vr")})))))
    ${muted("c3")}
    (local.set $cc ${g("apu_s0")})
    (if (i32.and (i32.ne (i32.or (local.get $bl) (local.get $br)) (i32.const 0)) (i32.ne ${g("c3_rshift")} (i32.const 4)))
      (then
        (local.set $end (i32.add (local.get $cc) (local.get $n)))
        (block $done (loop $major
          (local.set $nme ${g("c3_lcnt")})
          (if (i32.gt_u (local.get $nme) (local.get $end)) (then (local.set $nme (local.get $end))))
          (local.set $k (if (result i32) ${g("c3_master")} (then (call $c3_level)) (else (i32.const -15))))
          (block $wd (loop $wl
            (br_if $wd (i32.gt_u ${g("c3_wcnt")} (local.get $nme)))
            ${emit("c3", "(local.get $k)", `(i32.sub (local.get $cc) ${g("apu_s0")})`)}
            (local.set $cc ${g("c3_wcnt")})
            ${s("c3_lrt", g("c3_wcnt"))}
            ${s("c3_wcnt", `(i32.add ${g("c3_wcnt")} (call $c3_period ${g("c3_nr3")} ${g("c3_nr4")}))`)}
            ${s("c3_wpos", `(i32.and (i32.add ${g("c3_wpos")} (i32.const 1)) (i32.const 0x1F))`)}
            ${s("c3_sbuf", "(call $c3_sample)")}
            (local.set $k (call $c3_level))
            (br $wl)))
          (if (i32.lt_u (local.get $cc) (local.get $nme))
            (then
              ${emit("c3", "(local.get $k)", `(i32.sub (local.get $cc) ${g("apu_s0")})`)}
              (local.set $cc (local.get $nme))))
          (br_if $done (i32.ne ${g("c3_lcnt")} (local.get $nme)))
          (call $c3_l_event)
          (br $major))))
      (else
        ${emit("c3", "(i32.const -15)", "(i32.const 0)")}
        (local.set $cc (i32.add (local.get $cc) (local.get $n)))
        (block $d (loop $l
          (br_if $d (i32.gt_u ${g("c3_lcnt")} (local.get $cc)))
          (call $c3_updwave ${g("c3_lcnt")})
          (call $c3_l_event)
          (br $l)))
        (call $c3_updwave (local.get $cc)))))

  ;; ================= channel 4 (channel4.cpp) =================
${envWat("c4")}${lenWat("c4", 0x3F)}
  (func $c4_period (param $nr3 i32) (result i32) (local $sh i32) (local $r i32)
    (local.set $sh (i32.add (i32.shr_u (local.get $nr3) (i32.const 4)) (i32.const 3)))
    (local.set $r (i32.and (local.get $nr3) (i32.const 7)))
    (if (i32.eqz (local.get $r)) (then (local.set $r (i32.const 1)) (local.set $sh (i32.sub (local.get $sh) (i32.const 1)))))
    (i32.shl (local.get $r) (local.get $sh)))
  ;; ---- Lfsr ----
  (func $c4_f_updbak (param $cc i32) (local $per i32) (local $n i32) (local $x i32) (local $reg i32)
    (if (i32.le_u ${g("c4_fbak")} (local.get $cc))
      (then
        (local.set $per (call $c4_period ${g("c4_fnr3")}))
        (local.set $n (i32.add (i32.div_u (i32.sub (local.get $cc) ${g("c4_fbak")}) (local.get $per)) (i32.const 1)))
        ${s("c4_fbak", `(i32.add ${g("c4_fbak")} (i32.mul (local.get $n) (local.get $per)))`)}
        (if (i32.and (i32.ne ${g("c4_fmaster")} (i32.const 0)) (i32.lt_u ${g("c4_fnr3")} (i32.const 0xE0)))
          (then
            (local.set $reg ${g("c4_freg")})
            (if (i32.and ${g("c4_fnr3")} (i32.const 8))
              (then
                (block $d (loop $l
                  (br_if $d (i32.le_u (local.get $n) (i32.const 6)))
                  (local.set $x (i32.and (i32.xor (i32.shl (local.get $reg) (i32.const 1)) (local.get $reg)) (i32.const 0x7E)))
                  (local.set $reg (i32.and (i32.or (i32.or (i32.and (i32.shr_u (local.get $reg) (i32.const 6)) (i32.const -127))
                                                           (local.get $x)) (i32.shl (local.get $x) (i32.const 8))) (i32.const 0xFFFF)))
                  (local.set $n (i32.sub (local.get $n) (i32.const 6)))
                  (br $l)))
                (local.set $x (i32.and (i32.shl (i32.xor (local.get $reg) (i32.shr_u (local.get $reg) (i32.const 1)))
                                                (i32.sub (i32.const 7) (local.get $n))) (i32.const 0x7F)))
                (local.set $reg (i32.and (i32.or (i32.or
                  (i32.and (i32.shr_u (local.get $reg) (local.get $n))
                           (i32.xor (i32.sub (i32.const 0x80) (i32.shr_u (i32.const 0x80) (local.get $n))) (i32.const -1)))
                  (local.get $x)) (i32.shl (local.get $x) (i32.const 8))) (i32.const 0xFFFF))))
              (else
                (block $d (loop $l
                  (br_if $d (i32.le_u (local.get $n) (i32.const 15)))
                  (local.set $reg (i32.xor (local.get $reg) (i32.shr_u (local.get $reg) (i32.const 1))))
                  (local.set $n (i32.sub (local.get $n) (i32.const 15)))
                  (br $l)))
                (local.set $reg (i32.and (i32.or (i32.shr_u (local.get $reg) (local.get $n))
                  (i32.and (i32.shl (i32.xor (local.get $reg) (i32.shr_u (local.get $reg) (i32.const 1)))
                                    (i32.sub (i32.const 15) (local.get $n))) (i32.const 0x7FFF))) (i32.const 0xFFFF)))))
            ${s("c4_freg", "(local.get $reg)")})))))
  (func $c4_f_revive (param $cc i32)
    (call $c4_f_updbak (local.get $cc))
    ${s("c4_fcnt", g("c4_fbak"))})
  (func $c4_f_event (local $sh i32) (local $x i32)
    (if (i32.lt_u ${g("c4_fnr3")} (i32.const 0xE0))
      (then
        (local.set $sh (i32.shr_u ${g("c4_freg")} (i32.const 1)))
        (local.set $x (i32.and (i32.xor ${g("c4_freg")} (local.get $sh)) (i32.const 1)))
        ${s("c4_freg", "(i32.or (local.get $sh) (i32.shl (local.get $x) (i32.const 14)))")}
        (if (i32.and ${g("c4_fnr3")} (i32.const 8))
          (then ${s("c4_freg", `(i32.or (i32.and ${g("c4_freg")} (i32.const -65)) (i32.shl (local.get $x) (i32.const 6)))`)}))))
    ${s("c4_fcnt", `(i32.add ${g("c4_fcnt")} (call $c4_period ${g("c4_fnr3")}))`)}
    ${s("c4_fbak", g("c4_fcnt"))})
  (func $c4_f_nr3 (param $v i32) (param $cc i32)
    (call $c4_f_updbak (local.get $cc))
    ${s("c4_fnr3", "(local.get $v)")}
    ${s("c4_fcnt", "(local.get $cc)")})
  (func $c4_f_dismaster ${s("c4_fcnt", c(DIS))} ${s("c4_fmaster", c(0))} ${s("c4_freg", c(0x7FFF))})
  (func $c4_f_init (param $cc i32)
    (call $c4_f_dismaster)
    (call $c4_f_updbak (local.get $cc))
    ${s("c4_fmaster", c(1))}
    ${s("c4_fbak", `(i32.add ${g("c4_fbak")} (i32.const 4))`)}
    ${s("c4_fcnt", g("c4_fbak"))})
  (func $c4_f_reset (param $cc i32)
    ${s("c4_fnr3", c(0))}
    (call $c4_f_dismaster)
    ${s("c4_fbak", `(i32.add (local.get $cc) (call $c4_period (i32.const 0)))`)})
  ;; Ch4MasterDisabler
  (func $c4_disable ${s("c4_master", c(0))} (call $c4_f_dismaster))
  (func $c4_static (param $cc i32)
    (if (i32.and (i32.and (i32.or ${g("c4_sol")} ${g("c4_sor")}) (i32.ne ${g("c4_master")} (i32.const 0)))
                 (i32.ne ${g("c4_evol")} (i32.const 0)))
      (then (call $c4_f_revive (local.get $cc))) (else ${s("c4_fcnt", c(DIS))})))
  (func $c4_setevent
    ${s("c4_nev", c(1))}
    (if (i32.lt_u ${g("c4_lcnt")} ${g("c4_ecnt")}) (then ${s("c4_nev", c(2))})))
  (func $c4_nr1 (param $v i32) (call $c4_l_nr1 (local.get $v) ${g("c4_nr4")} ${g("apu_cc")}) (call $c4_setevent))
  (func $c4_nr2 (param $v i32)
    (if (call $c4_e_nr2 (local.get $v)) (then (call $c4_disable)) (else (call $c4_static ${g("apu_cc")})))
    (call $c4_setevent))
  (func $c4_nr3 (param $v i32) (call $c4_f_nr3 (local.get $v) ${g("apu_cc")}))
  (func $c4_nr4w (param $v i32)
    (call $c4_l_nr4 ${g("c4_nr4")} (local.get $v) ${g("apu_cc")})
    ${s("c4_nr4", "(local.get $v)")}
    (if (i32.and (local.get $v) (i32.const 0x80))
      (then
        ${s("c4_nr4", `(i32.and ${g("c4_nr4")} (i32.const 0x7F))`)}
        ${s("c4_master", `(i32.eqz (call $c4_e_init ${g("apu_cc")}))`)}
        (if ${g("c4_master")} (then (call $c4_f_init ${g("apu_cc")})))
        (call $c4_static ${g("apu_cc")})))
    (call $c4_setevent))
  (func $c4_setso (param $l i32) (param $r i32)
    ${s("c4_sol", "(local.get $l)")} ${s("c4_sor", "(local.get $r)")}
    (call $c4_static ${g("apu_cc")})
    (call $c4_setevent))
${squareUpdateWat("c4", { noise: true })}

  ;; ================= PSG (sound.cpp) =================
  ;; run all four channels over n native samples from $apu_cc
  (func $apu_run (param $n i32) (local $old i32)
    ${s("apu_s0", g("apu_cc"))}
    (call $c1_update (local.get $n))
    (call $c2_update (local.get $n))
    (call $c3_update (local.get $n))
    (call $c4_update (local.get $n))
    ${s("apu_cc", `(i32.add ${g("apu_s0")} (local.get $n))`)}
    ${s("apu_bph", `(i32.add ${g("apu_bph")} (local.get $n))`)}
    ;; each channel's counter_max rebase (they all share the counter)
    (if (i32.lt_s ${g("apu_cc")} (i32.const 0))
      (then
        (local.set $old ${g("apu_cc")})
        (call $c1_d_rebase (local.get $old)) ${rebaseCnt("c1_lcnt")} ${rebaseCnt("c1_ecnt")} ${rebaseCnt("c1_scnt")}
        (call $c2_d_rebase (local.get $old)) ${rebaseCnt("c2_lcnt")} ${rebaseCnt("c2_ecnt")}
        ${rebaseCnt("c3_lcnt")}
        ${rebaseCnt("c3_wcnt")}
        ${s("c3_lrt", `(i32.sub ${g("c3_lrt")} ${c(MAX)})`)}
        ${rebaseCnt("c4_lcnt")}
        (call $c4_f_updbak (local.get $old))
        ${s("c4_fbak", `(i32.sub ${g("c4_fbak")} ${c(MAX)})`)}
        ${rebaseCnt("c4_fcnt")} ${rebaseCnt("c4_ecnt")}
        ${s("apu_cc", `(i32.sub ${g("apu_cc")} ${c(MAX)})`)})))
  ;; PSG::generateSamples(cc, doubleSpeed)
  (func $apu_gen (param $cc i32) (local $sh i32) (local $n i32) (local $k i32)
    (if (i32.lt_s (i32.sub (local.get $cc) ${g("apu_last")}) (i32.const 0))
      (then (i32.store (i32.const ${L.guard}) (i32.add (i32.load (i32.const ${L.guard})) (i32.const 1))) (return)))
    (local.set $sh (i32.add (i32.const 1) (global.get $speed)))
    (local.set $n (i32.shr_u (i32.sub (local.get $cc) ${g("apu_last")}) (local.get $sh)))
    ${s("apu_last", `(i32.add ${g("apu_last")} (i32.shl (local.get $n) (local.get $sh)))`)}
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $n)))
      (local.set $k (if (result i32) (i32.gt_u (local.get $n) (i32.const ${SLICE})) (then (i32.const ${SLICE})) (else (local.get $n))))
      (call $apu_run (local.get $k))
      (local.set $n (i32.sub (local.get $n) (local.get $k)))
      ;; gambatte-libretro drains blipper once half its buffer is ready
      (if (i32.ge_u (i32.shr_u (i32.add ${g("apu_bph")} (i32.const ${PHASES - 1})) (i32.const 6)) (i32.const ${READ_AT}))
        (then (call $apu_read)))
      (br $l))))
  (func $apu_sovol (param $v i32)
    ${s("apu_vr", "(i32.shl (i32.add (i32.and (local.get $v) (i32.const 7)) (i32.const 1)) (i32.const 6))")}
    ${s("apu_vl", "(i32.shl (i32.add (i32.and (i32.shr_u (local.get $v) (i32.const 4)) (i32.const 7)) (i32.const 1)) (i32.const 6))")})
  (func $apu_mapso (param $v i32)
    (call $c1_setso (i32.and (i32.shr_u (local.get $v) (i32.const 4)) (i32.const 1)) (i32.and (local.get $v) (i32.const 1)))
    (call $c2_setso (i32.and (i32.shr_u (local.get $v) (i32.const 5)) (i32.const 1)) (i32.and (i32.shr_u (local.get $v) (i32.const 1)) (i32.const 1)))
    (call $c3_setso (i32.and (i32.shr_u (local.get $v) (i32.const 6)) (i32.const 1)) (i32.and (i32.shr_u (local.get $v) (i32.const 2)) (i32.const 1)))
    (call $c4_setso (i32.and (i32.shr_u (local.get $v) (i32.const 7)) (i32.const 1)) (i32.and (i32.shr_u (local.get $v) (i32.const 3)) (i32.const 1))))
  (func $apu_status (result i32)
    (i32.or (i32.or ${g("c1_master")} (i32.shl ${g("c2_master")} (i32.const 1)))
            (i32.or (i32.shl ${g("c3_master")} (i32.const 2)) (i32.shl ${g("c4_master")} (i32.const 3)))))
  ;; PSG::reset (NR52 off -> on). Channel::reset moves the shared counter:
  ;; cc &= 0xFFF; cc += ~(cc + 2) << 1 & 0x1000 (the frame sequencer position)
  (func $apu_reset
    ${s("apu_cc", `(i32.and ${g("apu_cc")} (i32.const 0xFFF))`)}
    ${s("apu_cc", `(i32.add ${g("apu_cc")} (i32.and (i32.shl (i32.xor (i32.add ${g("apu_cc")} (i32.const 2)) (i32.const -1)) (i32.const 1)) (i32.const 0x1000)))`)}
    (call $c1_d_reset) ${s("c1_ecnt", c(DIS))} ${s("c1_scnt", c(DIS))} (call $c1_setevent)
    (call $c2_d_reset) ${s("c2_ecnt", c(DIS))} (call $c2_setevent)
    ${s("c3_sbuf", c(0))}
    (call $c4_f_reset ${g("apu_cc")}) ${s("c4_ecnt", c(DIS))} (call $c4_setevent))

  ;; ---- Memory::nontrivial_ff_write, $FF10-$FF3F: the PSG side. The
  ;; register byte itself is stored by $iostore (IOTAB). Called at the top of
  ;; $iostore, so NR52-off's own writes of 0 through $FF10-$FF25 come back
  ;; here while the APU still counts as enabled; $apu_poweroff runs after.
  (func $apu_ffw (param $p i32) (param $v i32)
    (local $cc i32)
    (if (i32.or (i32.lt_u (local.get $p) (i32.const 0x10)) (i32.gt_u (local.get $p) (i32.const 0x3F))) (then (return)))
    (local.set $cc ${cc})
    (if (i32.ge_u (local.get $p) (i32.const 0x30))
      (then (call $apu_gen (local.get $cc)) (call $c3_wavewrite (i32.and (local.get $p) (i32.const 0xF)) (local.get $v)) (return)))
    (if (i32.eq (local.get $p) (i32.const 0x26))
      (then
        (if (i32.and (i32.xor (i32.load8_u (i32.const ${IOREG + 0x26})) (local.get $v)) (i32.const 0x80))
          (then
            (call $apu_gen (local.get $cc))
            (if (i32.and (local.get $v) (i32.const 0x80))
              (then (call $apu_reset) ${s("apu_en", c(1))}))))
        (return)))
    ;; with the APU off only NR11/NR21 (DMG: length bits), NR31 and NR41 (DMG) get through
    (if (i32.eqz ${g("apu_en")})
      (then
        ${cgb ? "(return)" : `(if (i32.or (i32.eq (local.get $p) (i32.const 0x11)) (i32.eq (local.get $p) (i32.const 0x16)))
          (then (local.set $v (i32.and (local.get $v) (i32.const 0x3F))))
          (else (if (i32.and (i32.ne (local.get $p) (i32.const 0x1B)) (i32.ne (local.get $p) (i32.const 0x20))) (then (return)))))`}))
    (if (i32.or (i32.eq (local.get $p) (i32.const 0x15)) (i32.eq (local.get $p) (i32.const 0x1F))) (then (return)))
    (call $apu_gen (local.get $cc))
    (block $b0x10 (block $b0x11 (block $b0x12 (block $b0x13 (block $b0x14 (block $bx
      (block $b0x16 (block $b0x17 (block $b0x18 (block $b0x19 (block $b0x1a (block $b0x1b (block $b0x1c (block $b0x1d (block $b0x1e
      (block $b0x20 (block $b0x21 (block $b0x22 (block $b0x23 (block $b0x24 (block $b0x25
        (br_table $b0x10 $b0x11 $b0x12 $b0x13 $b0x14 $bx $b0x16 $b0x17 $b0x18 $b0x19 $b0x1a $b0x1b $b0x1c $b0x1d $b0x1e $bx
                  $b0x20 $b0x21 $b0x22 $b0x23 $b0x24 $b0x25 $bx
                  (i32.sub (local.get $p) (i32.const 0x10))))
        (call $apu_mapso (local.get $v)) (return))
        (call $apu_sovol (local.get $v)) (return))
        (call $c4_nr4w (local.get $v)) (return))
        (call $c4_nr3 (local.get $v)) (return))
        (call $c4_nr2 (local.get $v)) (return))
        (call $c4_nr1 (local.get $v)) (return))
        (call $c3_nr4w (local.get $v)) (return))
        ${s("c3_nr3", "(local.get $v)")} (return))
        (call $c3_nr2 (local.get $v)) (return))
        (call $c3_nr1 (local.get $v)) (return))
        (call $c3_nr0 (local.get $v)) (return))
        (call $c2_nr4w (local.get $v)) (return))
        (call $c2_nr3 (local.get $v)) (return))
        (call $c2_nr2 (local.get $v)) (return))
        (call $c2_nr1 (local.get $v)) (return))
      (return))
      (call $c1_nr4w (local.get $v)) (return))
      (call $c1_nr3 (local.get $v)) (return))
      (call $c1_nr2 (local.get $v)) (return))
      (call $c1_nr1 (local.get $v)) (return))
    (call $c1_nr0 (local.get $v)))
  ;; NR52 off: after the writes of 0 through $FF10-$FF25, psg_.setEnabled(false)
  (func $apu_poweroff ${s("apu_en", c(0))})
  ;; Memory::nontrivial_ff_read for $FF26 and $FF30-$FF3F
  (func $apu_ffr (param $x i32) (result i32)
    (if (i32.eq (local.get $x) (i32.const 0xFF26))
      (then
        (if (i32.and (i32.load8_u (i32.const ${IOREG + 0x26})) (i32.const 0x80))
          (then
            (call $apu_gen ${cc})
            (i32.store8 (i32.const ${IOREG + 0x26}) (i32.or (i32.const 0xF0) (call $apu_status))))
          (else (i32.store8 (i32.const ${IOREG + 0x26}) (i32.const 0x70))))
        (return (i32.load8_u (i32.const ${IOREG + 0x26})))))
    (call $apu_gen ${cc})
    (call $c3_waveread (i32.and (local.get $x) (i32.const 0xF))))

  ;; ---- frame hand-off: fillSoundBuffer at gambatte's runFor end, then
  ;; gambatte-libretro reads every sample blipper has ready ----
  (func $apu_frame (param $cc i32)
    (call $apu_gen (local.get $cc))
    (call $apu_read)
    (i32.store (i32.const ${L.frames}) (i32.add (i32.load (i32.const ${L.frames})) (i32.const 1))))
  ;; Memory::resetCounters: lastUpdate_ = newCc - (oldCc - lastUpdate_)
  (func $apu_rebase (param $dec i32)
    ${s("apu_last", `(i32.sub ${g("apu_last")} (local.get $dec))`)})

  ;; ---- power-on: initstate.cpp's spu block through PSG::loadState ----
  (func $apu_init (local $i i32)
    ;; wave RAM = ioamhram $130-$13F
    (i32.store (i32.const ${L.wave}) (i32.load (i32.const ${IOREG + 0x30})))
    (i32.store (i32.const ${L.wave + 4}) (i32.load (i32.const ${IOREG + 0x34})))
    (i32.store (i32.const ${L.wave + 8}) (i32.load (i32.const ${IOREG + 0x38})))
    (i32.store (i32.const ${L.wave + 12}) (i32.load (i32.const ${IOREG + 0x3C})))
    (memory.fill (i32.const ${L.bufL}) (i32.const 0) (i32.const ${BUFN * 8}))
    (memory.fill (i32.const ${APU + 0x10}) (i32.const 0) (i32.const 0x30))
    ${s("apu_cc", c(IS.spuCycleCounter))}
    ${s("apu_last", c(IS.cpuCycleCounter))}
    ${s("apu_bph", c(0))} ${s("apu_il", c(0))} ${s("apu_ir", c(0))}
    ;; channel 1: sweep disabled; duty from the dump; envelope/length disabled
    ${s("c1_scnt", c(DIS))} ${s("c1_sshadow", c(0))} ${s("c1_snr0", c(0))} ${s("c1_sneg", c(0))}
    ${s("c1_dnpu", c(Math.max(IS.ch1.dutyNextPosUpdate, IS.spuCycleCounter)))}
    ${s("c1_dpos", c(IS.ch1.dutyPos & 7))} ${s("c1_dhigh", c(IS.ch1.dutyHigh))}
    ${s("c1_dduty", `(i32.shr_u (i32.load8_u (i32.const ${IOREG + 0x11})) (i32.const 6))`)}
    ${s("c1_dper", c(((2048 - (((IS.ch1.nr4 << 8) & 0x700) | IS.ch1.nr3)) * 2) & 0xFFFF))}
    ${s("c1_dee", c(1))}
    (call $c1_d_setcounter)
    ${s("c1_ecnt", c(DIS))} ${s("c1_evol", c(0))} ${s("c1_enr2", `(i32.load8_u (i32.const ${IOREG + 0x12}))`)}
    ${s("c1_lcnt", c(DIS))} ${s("c1_llen", c(IS.ch1.lengthCounter))}
    ${s("c1_nr4", c(IS.ch1.nr4))} ${s("c1_master", c(IS.ch1.master))}
    ${s("c1_nev", c(0))}
    ;; channel 2
    ${s("c2_dnpu", c(DIS))} ${s("c2_dpos", c(0))} ${s("c2_dhigh", c(0))}
    ${s("c2_dduty", `(i32.shr_u (i32.load8_u (i32.const ${IOREG + 0x16})) (i32.const 6))`)}
    ${s("c2_dper", c(4096))} ${s("c2_dee", c(1))}
    (call $c2_d_setcounter)
    ${s("c2_ecnt", c(DIS))} ${s("c2_evol", c(0))} ${s("c2_enr2", `(i32.load8_u (i32.const ${IOREG + 0x17}))`)}
    ${s("c2_lcnt", c(DIS))} ${s("c2_llen", c(IS.ch2.lengthCounter))}
    ${s("c2_nr4", c(0))} ${s("c2_master", c(0))} ${s("c2_nev", c(1))}
    ;; channel 3
    ${s("c3_lcnt", c(DIS))} ${s("c3_llen", c(IS.ch3.lengthCounter))}
    ${s("c3_wcnt", c(DIS))} ${s("c3_lrt", c(DIS))}
    ${s("c3_nr3", c(0))} ${s("c3_nr4", c(0))} ${s("c3_wpos", c(0))} ${s("c3_sbuf", c(0))} ${s("c3_master", c(0))}
    ${s("c3_nr0", `(i32.and (i32.load8_u (i32.const ${IOREG + 0x1A})) (i32.const 0x80))`)}
    (call $c3_nr2 (i32.load8_u (i32.const ${IOREG + 0x1C})))
    ;; channel 4
    ${s("c4_fcnt", c(Math.max(IS.ch4.lfsrCounter, IS.spuCycleCounter)))} ${s("c4_fbak", g("c4_fcnt"))}
    ${s("c4_freg", c(IS.ch4.lfsrReg))} ${s("c4_fmaster", c(0))}
    ${s("c4_fnr3", `(i32.load8_u (i32.const ${IOREG + 0x22}))`)}
    ${s("c4_ecnt", c(DIS))} ${s("c4_evol", c(0))} ${s("c4_enr2", `(i32.load8_u (i32.const ${IOREG + 0x21}))`)}
    ${s("c4_lcnt", c(DIS))} ${s("c4_llen", c(IS.ch4.lengthCounter))}
    ${s("c4_nr4", c(0))} ${s("c4_master", c(0))} ${s("c4_nev", c(1))}
    ;; PSG::loadState tail: NR50, NR51 (each channel's setSo), enable
    (call $apu_sovol (i32.load8_u (i32.const ${IOREG + 0x24})))
    (call $apu_mapso (i32.load8_u (i32.const ${IOREG + 0x25})))
    ${s("apu_en", `(i32.shr_u (i32.load8_u (i32.const ${IOREG + 0x26})) (i32.const 7))`)})
`;
}

/**
 * wc_get_info stores for the audio fields (wasmcart.h WCInfo): the ring, its
 * capacity in stereo frames, the write cursor, the sample rate. flags stays 0
 * (int16 samples).
 * @param {number} ABI  info struct address
 */
export function apuInfoWat(ABI) {
  const L = APU_LAYOUT;
  return `
    (i32.store (i32.const ${ABI + 16}) (i32.const ${L.ring}))
    (i32.store (i32.const ${ABI + 20}) (i32.const ${L.ringCap}))
    (i32.store (i32.const ${ABI + 24}) (i32.const ${L.writeCursor}))
    (i32.store (i32.const ${ABI + 52}) (i32.const ${APU_SAMPLE_RATE}))`;
}
