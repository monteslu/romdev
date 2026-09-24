// The cartridge GPIO port and its S-3511A real-time clock, ported from
// mGBA's src/gba/cart/gpio.c (GBAHardwareGPIOWrite, _rtcReadPins,
// _rtcBeginCommand, _rtcProcessByte, _rtcOutput, _rtcUpdateClock).
//
// mGBA gives a cart GPIO only when its override table (or the ROM-hack rule)
// names a device; romdev's libretro build reads the clock through the
// generic RTC source with no override, i.e. time(0), and turns it into a
// calendar with localtime_r. The cart reads the wasmcart host's frame clock
// the same way time() reads Date.now() (RTC_CLOCK: trunc((baseMs + ms) /
// 1000)) and converts it in UTC, which is what the reference computes while
// the verifier pins its clock (LibretroHost.setPinnedClock pins TZ=UTC too).
//
// The GPIO registers live in the ROM image, as in mGBA: gpioBase points at
// ROM $C4, so a write stores pinState/direction/control there while the
// port is readable and zeroes those three halfwords while it is not.
//
// Plain JS ESM + JSDoc.

import { RTC_CLOCK } from "../../recompile-section.js";

/** interface.h HW_* bits */
export const HW_RTC = 1;
export const HW_GPIO = 1 | 2 | 4 | 8 | 16;

/**
 * @param {Record<string, number>} L layout (L.ROM, L.ABI)
 * @param {number} hardware the override's HW_* bits (0: no GPIO device)
 * @returns {string} WAT: `$gpio_write` (always) and the RTC state
 */
export function gpioWat(L, hardware) {
  if (!(hardware & HW_GPIO)) {
    return `
  ;; no GPIO device on this cart: mGBA drops the write (Write to GPIO address
  ;; on cartridge without GPIO)
  (func $gpio_write (param $reg i32) (param $v i32))`;
  }
  const ROM = L.ROM, TIME = L.ABI + 0x180;
  const rtc = (hardware & HW_RTC) !== 0;
  // RTC_BYTES[8], one nibble each
  const RTC_BYTES = 0x03010700;
  return `
  ;; ---- cartridge GPIO (mGBA gpio.c) ----
  (global $gp_rw (mut i32) (i32.const 0))
  (global $gp_latch (mut i32) (i32.const 0))
  (global $gp_pins (mut i32) (i32.const 0))
  (global $gp_dir (mut i32) (i32.const 0))
  ;; GBAHardwareInitRTC
  (global $rtc_bytes (mut i32) (i32.const 0))
  (global $rtc_nbits (mut i32) (i32.const 0))
  (global $rtc_bits (mut i32) (i32.const 0))
  (global $rtc_active (mut i32) (i32.const 0))
  (global $rtc_sck (mut i32) (i32.const 1))
  (global $rtc_sio (mut i32) (i32.const 1))
  (global $rtc_cmd (mut i32) (i32.const 0))
  (global $rtc_ctl (mut i32) (i32.const 0x40))
  ;; time[0..6] (year, month, day, weekday, hour, minute, second; BCD), byte i = time[i]
  (global $rtc_time (mut i64) (i64.const 0))

  ;; _outputPins
  (func $gp_out (param $pins i32)
    (global.set $gp_pins (i32.or (i32.and (global.get $gp_pins) (global.get $gp_dir))
      (i32.and (i32.and (local.get $pins) (i32.xor (global.get $gp_dir) (i32.const -1))) (i32.const 0xF))))
    (if (global.get $gp_rw) (then (i32.store16 (i32.const ${ROM + 0xC4}) (global.get $gp_pins)))))

  ;; GBAHardwareGPIOWrite
  (func $gpio_write (param $reg i32) (param $v i32)
    (block $sw
      (if (i32.eq (local.get $reg) (i32.const 0xC4))
        (then
          (global.set $gp_latch (i32.and (local.get $v) (i32.const 0xF)))
          (global.set $gp_pins (i32.or (i32.and (global.get $gp_pins) (i32.xor (global.get $gp_dir) (i32.const -1)))
            (i32.and (global.get $gp_latch) (global.get $gp_dir))))
          (call $gp_readpins)
          (br $sw)))
      (if (i32.eq (local.get $reg) (i32.const 0xC6))
        (then
          (global.set $gp_dir (i32.and (local.get $v) (i32.const 0xF)))
          (global.set $gp_pins (i32.or (i32.and (global.get $gp_pins) (i32.xor (global.get $gp_dir) (i32.const -1)))
            (i32.and (global.get $gp_latch) (global.get $gp_dir))))
          (call $gp_readpins)
          (br $sw)))
      (global.set $gp_rw (i32.and (local.get $v) (i32.const 1))))
    (if (global.get $gp_rw)
      (then
        (i32.store16 (i32.const ${ROM + 0xC4}) (global.get $gp_pins))
        (i32.store16 (i32.const ${ROM + 0xC6}) (global.get $gp_dir))
        (i32.store16 (i32.const ${ROM + 0xC8}) (global.get $gp_rw)))
      (else
        (i32.store16 (i32.const ${ROM + 0xC4}) (i32.const 0))
        (i32.store16 (i32.const ${ROM + 0xC6}) (i32.const 0))
        (i32.store16 (i32.const ${ROM + 0xC8}) (i32.const 0)))))

  ;; _readPins: the devices this cart has
  (func $gp_readpins
    ${rtc ? "(call $rtc_readpins)" : ""})
${rtc ? rtcWat(RTC_BYTES, TIME) : ""}`;
}

function rtcWat(RTC_BYTES, TIME) {
  const bytesOf = (c) => `(i32.and (i32.shr_u (i32.const ${RTC_BYTES}) (i32.shl (i32.and (i32.shr_u ${c} (i32.const 4)) (i32.const 7)) (i32.const 2))) (i32.const 0xF))`;
  // rtc.bits: clear bit bitsRead, then set it from SIO (pin 1)
  const shiftIn = `
        (global.set $rtc_bits (i32.and (global.get $rtc_bits) (i32.xor (i32.shl (i32.const 1) (global.get $rtc_nbits)) (i32.const -1))))
        (global.set $rtc_bits (i32.or (global.get $rtc_bits)
          (i32.shl (i32.shr_u (i32.and (global.get $gp_pins) (i32.const 2)) (i32.const 1)) (global.get $rtc_nbits))))`;
  return `
  ;; _rtcBCD
  (func $rtc_bcd (param $v i32) (result i32)
    (i32.or (i32.rem_u (local.get $v) (i32.const 10))
      (i32.shl (i32.rem_u (i32.div_u (local.get $v) (i32.const 10)) (i32.const 10)) (i32.const 4))))

  ;; _rtcUpdateClock: t = time(0) (the host frame clock as time() reads
  ;; Date.now()), offset 0, localtime_r in UTC (days-from-civil inverse)
  (func $rtc_update
    (local $t i64) (local $days i32) (local $s i32) (local $z i32) (local $era i32) (local $doe i32)
    (local $yoe i32) (local $y i32) (local $doy i32) (local $mp i32) (local $d i32) (local $m i32) (local $h i32) (local $r i64)
    (local.set $t (i64.trunc_f64_s (f64.div (f64.add (f64.const ${RTC_CLOCK.baseMs}) (f64.load (i32.const ${TIME}))) (f64.const 1000))))
    (local.set $days (i32.wrap_i64 (i64.div_s (local.get $t) (i64.const 86400))))
    (local.set $s (i32.wrap_i64 (i64.rem_s (local.get $t) (i64.const 86400))))
    (if (i32.lt_s (local.get $s) (i32.const 0))
      (then (local.set $s (i32.add (local.get $s) (i32.const 86400))) (local.set $days (i32.sub (local.get $days) (i32.const 1)))))
    (local.set $z (i32.add (local.get $days) (i32.const 719468)))
    (local.set $era (i32.div_s (i32.sub (local.get $z) (select (i32.const 0) (i32.const 146096) (i32.ge_s (local.get $z) (i32.const 0)))) (i32.const 146097)))
    (local.set $doe (i32.sub (local.get $z) (i32.mul (local.get $era) (i32.const 146097))))
    (local.set $yoe (i32.div_u (i32.sub (i32.add (i32.sub (local.get $doe) (i32.div_u (local.get $doe) (i32.const 1460)))
      (i32.div_u (local.get $doe) (i32.const 36524))) (i32.div_u (local.get $doe) (i32.const 146096))) (i32.const 365)))
    (local.set $y (i32.add (local.get $yoe) (i32.mul (local.get $era) (i32.const 400))))
    (local.set $doy (i32.sub (local.get $doe) (i32.sub (i32.add (i32.mul (i32.const 365) (local.get $yoe)) (i32.div_u (local.get $yoe) (i32.const 4)))
      (i32.div_u (local.get $yoe) (i32.const 100)))))
    (local.set $mp (i32.div_u (i32.add (i32.mul (i32.const 5) (local.get $doy)) (i32.const 2)) (i32.const 153)))
    (local.set $d (i32.add (i32.sub (local.get $doy) (i32.div_u (i32.add (i32.mul (i32.const 153) (local.get $mp)) (i32.const 2)) (i32.const 5))) (i32.const 1)))
    (local.set $m (select (i32.add (local.get $mp) (i32.const 3)) (i32.sub (local.get $mp) (i32.const 9)) (i32.lt_u (local.get $mp) (i32.const 10))))
    (if (i32.le_u (local.get $m) (i32.const 2)) (then (local.set $y (i32.add (local.get $y) (i32.const 1)))))
    (local.set $h (i32.div_u (local.get $s) (i32.const 3600)))
    ;; tm_year - 100 = y - 2000, tm_mon + 1 = m, tm_wday: 1970-01-01 was a Thursday
    (local.set $r (i64.extend_i32_u (call $rtc_bcd (i32.sub (local.get $y) (i32.const 2000)))))
    (local.set $r (i64.or (local.get $r) (i64.shl (i64.extend_i32_u (call $rtc_bcd (local.get $m))) (i64.const 8))))
    (local.set $r (i64.or (local.get $r) (i64.shl (i64.extend_i32_u (call $rtc_bcd (local.get $d))) (i64.const 16))))
    (local.set $r (i64.or (local.get $r) (i64.shl (i64.extend_i32_u (call $rtc_bcd
      (i32.rem_s (i32.add (i32.rem_s (i32.add (local.get $days) (i32.const 4)) (i32.const 7)) (i32.const 7)) (i32.const 7)))) (i64.const 24))))
    (local.set $r (i64.or (local.get $r) (i64.shl (i64.extend_i32_u (call $rtc_bcd
      (if (result i32) (i32.and (global.get $rtc_ctl) (i32.const 0x40)) (then (local.get $h)) (else (i32.rem_u (local.get $h) (i32.const 12)))))) (i64.const 32))))
    (local.set $r (i64.or (local.get $r) (i64.shl (i64.extend_i32_u (call $rtc_bcd (i32.rem_u (i32.div_u (local.get $s) (i32.const 60)) (i32.const 60)))) (i64.const 40))))
    (local.set $r (i64.or (local.get $r) (i64.shl (i64.extend_i32_u (call $rtc_bcd (i32.rem_u (local.get $s) (i32.const 60)))) (i64.const 48))))
    (global.set $rtc_time (local.get $r)))

  ;; _rtcBeginCommand
  (func $rtc_begin
    (local $c i32)
    (if (i32.eq (i32.and (global.get $rtc_bits) (i32.const 0xF)) (i32.const 0x06))
      (then
        (global.set $rtc_cmd (global.get $rtc_bits))
        (global.set $rtc_bytes ${bytesOf("(global.get $rtc_bits)")})
        (global.set $rtc_active (i32.const 1))
        (local.set $c (i32.and (i32.shr_u (global.get $rtc_bits) (i32.const 4)) (i32.const 7)))
        (if (i32.eqz (local.get $c)) (then (global.set $rtc_ctl (i32.const 0))))
        (if (i32.or (i32.eq (local.get $c) (i32.const 2)) (i32.eq (local.get $c) (i32.const 6))) (then (call $rtc_update)))))
    (global.set $rtc_bits (i32.const 0))
    (global.set $rtc_nbits (i32.const 0)))

  ;; _rtcProcessByte
  (func $rtc_byte
    (if (i32.eq (i32.and (i32.shr_u (global.get $rtc_cmd) (i32.const 4)) (i32.const 7)) (i32.const 4))
      (then (global.set $rtc_ctl (i32.and (global.get $rtc_bits) (i32.const 0xFF)))))
    (global.set $rtc_bits (i32.const 0))
    (global.set $rtc_nbits (i32.const 0))
    (global.set $rtc_bytes (i32.sub (global.get $rtc_bytes) (i32.const 1)))
    (if (i32.le_s (global.get $rtc_bytes) (i32.const 0))
      (then (global.set $rtc_bytes ${bytesOf("(global.get $rtc_cmd)")}))))

  ;; _rtcOutput
  (func $rtc_output (result i32)
    (local $c i32) (local $b i32)
    (local.set $b (i32.const 0xFF))
    (local.set $c (i32.and (i32.shr_u (global.get $rtc_cmd) (i32.const 4)) (i32.const 7)))
    (if (i32.eq (local.get $c) (i32.const 4)) (then (local.set $b (global.get $rtc_ctl))))
    (if (i32.or (i32.eq (local.get $c) (i32.const 2)) (i32.eq (local.get $c) (i32.const 6)))
      (then (local.set $b (i32.wrap_i64 (i64.and (i64.shr_u (global.get $rtc_time)
        (i64.extend_i32_u (i32.shl (i32.sub (i32.const 7) (global.get $rtc_bytes)) (i32.const 3)))) (i64.const 0xFF))))))
    (i32.and (i32.shr_u (local.get $b) (global.get $rtc_nbits)) (i32.const 1)))

  ;; _rtcReadPins. P: 0 SCK, 1 SIO, 2 CS
  (func $rtc_readpins
    (call $gp_out (i32.and (global.get $gp_pins) (i32.const 2)))
    (if (i32.eqz (i32.and (global.get $gp_pins) (i32.const 4)))
      (then
        (global.set $rtc_nbits (i32.const 0))
        (global.set $rtc_bytes (i32.const 0))
        (global.set $rtc_active (i32.const 0))
        (global.set $rtc_cmd (i32.const 0))
        (global.set $rtc_sck (i32.const 1))
        (global.set $rtc_sio (i32.const 1))
        (call $gp_out (i32.const 2))
        (return)))
    (if (i32.eqz (global.get $rtc_active))
      (then
        (call $gp_out (i32.const 2))
        (if (i32.eqz (i32.and (global.get $gp_pins) (i32.const 1))) (then ${shiftIn}))
        (if (i32.and (i32.eqz (global.get $rtc_sck)) (i32.and (global.get $gp_pins) (i32.const 1)))
          (then
            (global.set $rtc_nbits (i32.add (global.get $rtc_nbits) (i32.const 1)))
            (if (i32.eq (global.get $rtc_nbits) (i32.const 8)) (then (call $rtc_begin))))))
      (else
        (if (i32.eqz (i32.and (global.get $rtc_cmd) (i32.const 0x80)))
          (then
            (call $gp_out (i32.const 2))
            (if (i32.eqz (i32.and (global.get $gp_pins) (i32.const 1))) (then ${shiftIn}))
            (if (i32.and (i32.eqz (global.get $rtc_sck)) (i32.and (global.get $gp_pins) (i32.const 1)))
              (then
                (if (i32.xor (i32.and (i32.shr_u (global.get $rtc_bits) (global.get $rtc_nbits)) (i32.const 1))
                      (i32.shr_u (i32.and (global.get $gp_pins) (i32.const 2)) (i32.const 1)))
                  (then (global.set $rtc_bits (i32.and (global.get $rtc_bits)
                    (i32.xor (i32.shl (i32.const 1) (global.get $rtc_nbits)) (i32.const -1))))))
                (global.set $rtc_nbits (i32.add (global.get $rtc_nbits) (i32.const 1)))
                (if (i32.eq (global.get $rtc_nbits) (i32.const 8)) (then (call $rtc_byte))))))
          (else
            (if (i32.and (global.get $rtc_sck) (i32.eqz (i32.and (global.get $gp_pins) (i32.const 1))))
              (then
                (global.set $rtc_sio (call $rtc_output))
                (global.set $rtc_nbits (i32.add (global.get $rtc_nbits) (i32.const 1)))
                (if (i32.eq (global.get $rtc_nbits) (i32.const 8))
                  (then
                    (global.set $rtc_bytes (i32.sub (global.get $rtc_bytes) (i32.const 1)))
                    (if (i32.le_s (global.get $rtc_bytes) (i32.const 0))
                      (then (global.set $rtc_bytes ${bytesOf("(global.get $rtc_cmd)")})))
                    (global.set $rtc_nbits (i32.const 0))))))
            (call $gp_out (i32.shl (global.get $rtc_sio) (i32.const 1)))))))
    (global.set $rtc_sck (i32.ne (i32.and (global.get $gp_pins) (i32.const 1)) (i32.const 0))))`;
}
