// SMS / Game Gear hardware in WAT: VDP (Mode 4), I/O ports, SN76489 PSG,
// the scanline renderer, the CRAM -> RGB conversion and the small Z80 block
// helpers that are simpler as calls than inline.
//
// Ported from the earlier Python emitter (misc, cram and start
// bodies). The WAT text is the Python emitter's with its commentary removed;
// the rationale for each behaviour (the genesis_plus_gx frame order, the
// 565 palette round-trip, status-port latch rules, TH region detection on
// port $3F) is kept in the JS comments below.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";

const HC_DATA = JSON.parse(readFileSync(new URL("./gpgx-hcounter.json", import.meta.url), "utf8"));
const HC_TABLE = HC_DATA.hc;
const HCOL_TABLE = HC_DATA.hcol;
const HLAT_TABLE = HC_DATA.hlat;

// Linear memory map (beyond the 64KB Z80 address space at 0):
//   0x10000  VRAM 16KB           0x14000  CRAM (32 SMS / 64 GG bytes)
//   0x14100  VDP registers       0x14200  VDP latch state
//   0x14300  CRAM->RGB888 LUT    0x14380  PROBE (liveness counters)
//   0x14400  LINEPROBE, 192 x 8 bytes: R1 R2 R8 R9, name-table row read,
//            non-blank entries on that row, u16 non-zero BG pixels. The
//            end-of-frame registers are not what a mid-frame line rendered.
//   0x14A80  PCWATCH, 4 x (u32 pc, u32 hits): host-armed PC counters
//   0x14AC0  IOREGS (Game Gear I/O registers $00-$06)
//   0x14B00  HCTAB, 228 bytes: H counter per T-state of a line
//   0x15000  SMSFB, 256x192 palette indices
export const VRAM = 0x10000;
export const CRAM = 0x14000;
export const VREG = 0x14100;
export const VSTATE = 0x14200;
export const GGLUT = 0x14300;
export const PROBE = 0x14380;
export const LINEPROBE = 0x14400;
export const PCWATCH = 0x14A80;
export const SMSFB = 0x15000;
/** genesis_plus_gx's fixed Master System colours for the TMS9918 modes (tms_crom), 16 bytes. */
export const TMSCROM = 0x14F00;
const TMS_CROM = [0x00, 0x00, 0x08, 0x0C, 0x10, 0x30, 0x01, 0x3C, 0x02, 0x03, 0x05, 0x0F, 0x04, 0x33, 0x15, 0x3F];

/**
 * 4-bit channel -> 8-bit, as genesis_plus_gx presents it. The core is built
 * with 16bpp rendering, so a 4-bit channel is packed into RGB565 and the
 * presented frame expands 565 -> 888 by bit replication: red and blue
 * round-trip through 5 bits and GREEN through 6, so green needs its own table
 * (n*17 is off by 1-4 on nearly every colour). SMS 2-bit channels index the
 * same table at n*5 (gpgx widens them to 4 bits first).
 * @returns {Uint8Array} 48 bytes: R[16] G[16] B[16]
 */
export function ggLutBytes() {
  const mk = (r, g, b) => (r << 12) | ((r >> 3) << 11) | (g << 7) | ((g >> 2) << 5) | (b << 1) | (b >> 3);
  const exp = (p) => {
    const R = (p >> 11) & 0x1F, G = (p >> 5) & 0x3F, B = p & 0x1F;
    return [(R << 3) | (R >> 2), (G << 2) | (G >> 4), (B << 3) | (B >> 2)];
  };
  const out = new Uint8Array(48);
  for (let n = 0; n < 16; n++) {
    out[n] = exp(mk(n, 0, 0))[0];
    out[16 + n] = exp(mk(0, n, 0))[1];
    out[32 + n] = exp(mk(0, 0, n))[2];
  }
  return out;
}

/**
 * VDP + I/O dispatch. `platform` is 'sms' or 'gg'. GG differences: CRAM is
 * 64 bytes (32 colours x 2, write mask 0x3F), and port $00 carries the GG
 * START button (bit 7, active low; bit 6 region).
 *
 * Notes on behaviour, all measured against genesis_plus_gx:
 *  - status-port reads return bits 4-0 as 1 (0x9F with only VBlank set) and
 *    clear VBlank, collision and the pending H-INT, and reset the latch;
 *  - port $3F drives the TH output levels, read back on $DD bits 6/7 (the
 *    region check: ioctl $F5 -> $DD $FF, ioctl $55 -> $DD $3F);
 *  - $vdpwn counts data-port writes only (no ring: a probe written into
 *    another region's memory corrupts what it measures).
 * @param {'sms'|'gg'} platform
 */
export function hwWat(platform = "sms", opts = {}) {
  if (opts.exact) return hwExactWat(platform, opts);
  const CMASK = platform === "gg" ? 0x3F : 0x1F;
  const GGPORT = platform === "gg"
    ? `    (if (i32.eq (local.get $p) (i32.const 0x00))
      (then (return (i32.or (i32.and (global.get $ggstart) (i32.const 0x80))
                            (i32.const 0x7F)))))`
    : "";
  return `
  (global $vdp_latch (mut i32) (i32.const 0))
  (global $vdp_addr  (mut i32) (i32.const 0))
  (global $vdp_code  (mut i32) (i32.const 0))
  (global $vdp_first (mut i32) (i32.const 1))
  (global $vdp_status (mut i32) (i32.const 0))
  (global $hintpend (mut i32) (i32.const 0))
  (global $vdp_readbuf (mut i32) (i32.const 0))
  (global $line (mut i32) (i32.const 0))
  (global $lineint (mut i32) (i32.const 0))
  (global $ggstart (mut i32) (i32.const 0x80))

  (global $dbg_r1pc (mut i32) (i32.const 0))
  (global $dbg_r1d (mut i32) (i32.const 0))
  (global $dbg_r1e (mut i32) (i32.const 0))
  (global $dbg_r1val (mut i32) (i32.const 0))
  (func $vdp_ctrl_write (param $v i32)
    (if (global.get $vdp_first)
      (then
        (global.set $vdp_latch (i32.and (local.get $v) (i32.const 0xFF)))
        (global.set $vdp_first (i32.const 0)))
      (else
        (global.set $vdp_first (i32.const 1))
        (global.set $vdp_code (i32.shr_u (i32.and (local.get $v) (i32.const 0xC0)) (i32.const 6)))
        (global.set $vdp_addr (i32.or (global.get $vdp_latch)
          (i32.shl (i32.and (local.get $v) (i32.const 0x3F)) (i32.const 8))))
        (if (i32.eq (global.get $vdp_code) (i32.const 2))
          (then
            (if (i32.eq (i32.and (local.get $v) (i32.const 0x0F)) (i32.const 1))
              (then (global.set $dbg_r1pc (global.get $pc))
                    (global.set $dbg_r1val (global.get $vdp_latch))
                    (global.set $dbg_r1d (global.get $d))
                    (global.set $dbg_r1e (global.get $e))))
            (i32.store8 (i32.add (i32.const ${VREG})
                          (i32.and (local.get $v) (i32.const 0x0F)))
                        (global.get $vdp_latch))))
        (if (i32.eqz (global.get $vdp_code))
          (then
            (global.set $vdp_readbuf
              (i32.load8_u (i32.add (i32.const ${VRAM}) (global.get $vdp_addr))))
            (global.set $vdp_addr
              (i32.and (i32.add (global.get $vdp_addr) (i32.const 1)) (i32.const 0x3FFF))))))))

  (global $vdpwn (mut i32) (i32.const 0))
  (func $vdp_data_write (param $v i32)
    (global.set $vdpwn (i32.add (global.get $vdpwn) (i32.const 1)))
    (global.set $vdp_first (i32.const 1))
    (if (i32.eq (global.get $vdp_code) (i32.const 3))
      (then
        (i32.store8 (i32.add (i32.const ${CRAM})
                      (i32.and (global.get $vdp_addr) (i32.const ${CMASK})))
                    (i32.and (local.get $v) (i32.const 0xFF))))
      (else
        (i32.store8 (i32.add (i32.const ${VRAM}) (global.get $vdp_addr))
                    (i32.and (local.get $v) (i32.const 0xFF)))))
    (global.set $vdp_readbuf (i32.and (local.get $v) (i32.const 0xFF)))
    (global.set $vdp_addr
      (i32.and (i32.add (global.get $vdp_addr) (i32.const 1)) (i32.const 0x3FFF))))

  (func $vdp_data_read (result i32)
    (local $r i32)
    (global.set $vdp_first (i32.const 1))
    (local.set $r (global.get $vdp_readbuf))
    (global.set $vdp_readbuf
      (i32.load8_u (i32.add (i32.const ${VRAM}) (global.get $vdp_addr))))
    (global.set $vdp_addr
      (i32.and (i32.add (global.get $vdp_addr) (i32.const 1)) (i32.const 0x3FFF)))
    (local.get $r))

  (func $vdp_status_read (result i32)
    (local $s i32)
    (local.set $s (i32.or (global.get $vdp_status) (i32.const 0x1F)))
    (global.set $vdp_status (i32.const 0))
    (global.set $hintpend (i32.const 0))
    (global.set $vdp_first (i32.const 1))
    (local.get $s))

  (func $vreg (param $n i32) (result i32)
    (i32.load8_u (i32.add (i32.const ${VREG}) (local.get $n))))

  (func $io_write (param $port i32) (param $v i32)
    (local $p i32)
    (local.set $p (i32.and (local.get $port) (i32.const 0xFF)))
    (block $done
      (if (i32.eq (local.get $p) (i32.const 0xBF))
        (then (call $vdp_ctrl_write (local.get $v)) (br $done)))
      (if (i32.eq (local.get $p) (i32.const 0xBE))
        (then (call $vdp_data_write (local.get $v)) (br $done)))
      (if (i32.or (i32.eq (local.get $p) (i32.const 0x7E))
                  (i32.eq (local.get $p) (i32.const 0x7F)))
        (then (call $psg_write (local.get $v)) (br $done)))
      (if (i32.eq (local.get $p) (i32.const 0x3F))
        (then (global.set $ioctl (i32.and (local.get $v) (i32.const 0xFF))) (br $done)))))

  (global $ioctl (mut i32) (i32.const 0xFF))

  (func $io_read (param $port i32) (result i32)
    (local $p i32)
    (local.set $p (i32.and (local.get $port) (i32.const 0xFF)))
    (if (i32.eq (local.get $p) (i32.const 0xBF)) (then (return (call $vdp_status_read))))
    (if (i32.eq (local.get $p) (i32.const 0xBE)) (then (return (call $vdp_data_read))))
    (if (i32.eq (local.get $p) (i32.const 0x7E)) (then (return (global.get $line))))
    (if (i32.eq (local.get $p) (i32.const 0x7F)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $p) (i32.const 0xDC)) (then (return (global.get $joy1))))
${GGPORT}
    (if (i32.eq (local.get $p) (i32.const 0xDD))
      (then (return (i32.or
        (i32.and (global.get $joy2) (i32.const 0x3F))
        (i32.or
          (i32.shl (i32.and (i32.shr_u (global.get $ioctl) (i32.const 5)) (i32.const 1)) (i32.const 6))
          (i32.shl (i32.and (i32.shr_u (global.get $ioctl) (i32.const 7)) (i32.const 1)) (i32.const 7)))))))
    (i32.const 0xFF))
`;
}

/** Game Gear I/O registers $00-$06 and the SMS memory/I/O control latches. */
export const IOREGS = 0x14AC0;
/** H counter by T-state within the line (gpgx cycle2hc32 sampled every 15 master cycles). */
export const HCTAB = 0x14B00;
/** The same table as gpgx's collision check samples it (+545 master cycles). */
export const HCOLTAB = 0x14C00;
/** Sprites parsed for the NEXT line (gpgx parse_satb): u8 count, then 8 x {x, attr, row, 0}. */
export const OBJLIST = 0x14D00;
/** The H counter a TH low-to-high write on port $3F latches, by T-state (gpgx io_z80_write). */
export const HLATTAB = 0x14E00;

/**
 * VDP + I/O modelled the way genesis_plus_gx models them (the banked
 * emitter's default): I/O ports decoded by `port & 0xC1` with the SMS/GG
 * mirrors, the Game Gear I/O registers $00-$06 (serial/link registers read
 * back what was written, with gpgx's reset values), the V counter read at the
 * cycle the IN completes (the next line once the line's budget is spent) and
 * folded at $DA, the H counter from gpgx's cycle table, the status low bits
 * only in Mode 4, and a status read that lands after the end of line 192 sees
 * (and consumes) the VINT flag early. `$curbudget` is the line budget left
 * after the IN instruction's own cost, set by every IN arm.
 * Also as gpgx: the H counter reads the value latched by the last TH
 * low-to-high write on port $3F (vdp_reset starts it latched at 0, and Mode 4
 * never unlatches it); TH/TR read back the written level only when configured
 * as outputs (io_z80_read), always 0 on a Japanese console; a Japanese
 * console decodes the I/O ports by full address and has the FM audio control
 * register at $F2; PAL consoles run 313 lines with the V counter folded at $F2.
 * @param {'sms'|'gg'} platform
 * @param {{region?: 'export'|'japan', pal?: boolean, fm?: boolean}} opts
 */
function hwExactWat(platform, opts) {
  // a Game Gear in SMS mode (opts.ggms): the GG's port decoding without its
  // registers at $00-$06, and the Master System VDP's CRAM
  const ggVdp = platform === "gg" && !opts.ggms;
  const legacy = hwWat(ggVdp ? "gg" : "sms");
  const cut = legacy.indexOf("  (func $vdp_status_read");
  const gg = platform === "gg";
  // gpgx vdp_sms_ctrl_w: the first control byte already replaces the address
  // LSB (a data access before the second byte uses it).
  let vdpPart = legacy.slice(0, cut);
  const first = `        (global.set $vdp_latch (i32.and (local.get $v) (i32.const 0xFF)))
        (global.set $vdp_first (i32.const 0)))`;
  if (!vdpPart.includes(first)) throw new Error("sms recompile: control-port first byte not found in the VDP text");
  vdpPart = vdpPart.replace(first, `        (global.set $vdp_latch (i32.and (local.get $v) (i32.const 0xFF)))
        (global.set $vdp_addr (i32.or (i32.and (global.get $vdp_addr) (i32.const 0x3F00)) (global.get $vdp_latch)))
        (global.set $vdp_first (i32.const 0)))`);
  // register writes go through gpgx's vdp_reg_w / mode checks ($vdp_reg_w)
  const regStore = `            (i32.store8 (i32.add (i32.const ${VREG})
                          (i32.and (local.get $v) (i32.const 0x0F)))
                        (global.get $vdp_latch))))`;
  if (!vdpPart.includes(regStore)) throw new Error("sms recompile: register store not found in the VDP text");
  vdpPart = vdpPart.replace(regStore, "            (call $vdp_reg_w (i32.and (local.get $v) (i32.const 0x0F)) (global.get $vdp_latch))))");
  if (ggVdp) {
    // gpgx vdp_z80_data_w_gg: CRAM is written a colour (two bytes) at a time;
    // an even address only latches the byte, the odd one stores the pair.
    const cramStore = `        (i32.store8 (i32.add (i32.const ${CRAM})
                      (i32.and (global.get $vdp_addr) (i32.const 63)))
                    (i32.and (local.get $v) (i32.const 0xFF))))`;
    if (!vdpPart.includes(cramStore)) throw new Error("sms recompile: CRAM store not found in the VDP text");
    vdpPart = vdpPart.replace(cramStore, `        (if (i32.and (global.get $vdp_addr) (i32.const 1))
          (then (i32.store16 (i32.add (i32.const ${CRAM}) (i32.and (global.get $vdp_addr) (i32.const 0x3E)))
                  (i32.or (i32.shl (i32.and (local.get $v) (i32.const 0xFF)) (i32.const 8)) (global.get $cram_latch))))
          (else (global.set $cram_latch (i32.and (local.get $v) (i32.const 0xFF))))))`) + "  ;; vdp_reset: cached_write = -1, so an odd write before any even one stores $FFFF\n  (global $cram_latch (mut i32) (i32.const -1))\n";
  }
  const japan = opts.region === "japan";
  const LINES = opts.pal ? 313 : 262;
  // GG port $00: bit 6 = export, bit 5 = PAL (gpgx io_reset: 0x80 | region_code >> 1)
  const io0 = gg ? (japan ? 0x80 : 0xC0) | (opts.pal ? 0x20 : 0) : 0;
  const tInLine = `(select (i32.sub (i32.const 228) (global.get $curbudget))
                          (i32.sub (i32.const 0) (global.get $curbudget))
                          (i32.gt_s (global.get $curbudget) (i32.const 0)))`;
  // port $3F: TH low-to-high on either port latches the H counter
  const IOCTL_W = `(call $ioctl_write (local.get $v))`;
  return vdpPart + `  (global $curbudget (mut i32) (i32.const 228))
  (global $vintdone (mut i32) (i32.const 0))
  (global $memctl (mut i32) (i32.const 0xA8))
  (global $ioctl (mut i32) (i32.const 0xFF))
  (global $hvlatch (mut i32) (i32.const 0x10000))
  (global $vcmax (mut i32) (i32.const ${opts.pal ? 0xF2 : 0xDA}))
  (global $io6 (mut i32) (i32.const 0))
  (global $vph (mut i32) (i32.const 192))
  (global $vpchanged (mut i32) (i32.const 0))

  ;; gpgx vdp_reg_w (Mode 4 part) + vdp_sms_ctrl_w's mode check: R11-R15 are
  ;; not writable in Mode 4; toggling the display early in an active line
  ;; (within 860 master cycles) redraws that line; on the 315-5246 / Game
  ;; Gear VDPs M1/M3 select the 224 / 240 line modes, whose V counter fold
  ;; applies at once and whose height from the next frame.
  (func $vdp_reg_w (param $r i32) (param $d i32)
    (local $prev i32) (local $mode i32) (local $h i32) (local $redraw i32)
    (if (i32.and (i32.eqz (i32.and (call $vreg (i32.const 1)) (i32.const 4))) (i32.gt_u (local.get $r) (i32.const 10))) (then (return)))
    (local.set $prev (i32.or (i32.and (call $vreg (i32.const 0)) (i32.const 6)) (i32.and (call $vreg (i32.const 1)) (i32.const 0x18))))
    (if (i32.eq (local.get $r) (i32.const 1))
      (then (if (i32.and (i32.and (i32.ne (i32.and (i32.xor (local.get $d) (call $vreg (i32.const 1))) (i32.const 0x40)) (i32.const 0))
                                  (i32.lt_u (global.get $line) (global.get $vph)))
                         (i32.and (i32.gt_s (global.get $curbudget) (i32.const 0))
                                  (i32.le_s (i32.mul (i32.sub (i32.const 228) (global.get $curbudget)) (i32.const 15)) (i32.const 860))))
              (then (local.set $redraw (i32.const 1))))
            ;; gpgx vdp_reg_w case 1: R1 bit 2 (the Mega Drive's Mode 5
            ;; select) has no effect on these VDPs and is cleared when a
            ;; write changes it, "to avoid mode 5 detection elsewhere".
            (if (i32.and (i32.xor (local.get $d) (call $vreg (i32.const 1))) (i32.const 4))
              (then (local.set $d (i32.and (local.get $d) (i32.const 0xFB)))))))
    (i32.store8 (i32.add (i32.const ${VREG}) (local.get $r)) (local.get $d))
    (if (local.get $redraw) (then (call $render_line (global.get $line))))
${opts.sms1 ? "" : `    (local.set $mode (i32.or (i32.and (call $vreg (i32.const 0)) (i32.const 6)) (i32.and (call $vreg (i32.const 1)) (i32.const 0x18))))
    (if (i32.ne (local.get $mode) (local.get $prev))
      (then
        (local.set $h (i32.const 192))
        (global.set $vcmax (i32.const ${opts.pal ? 0xF2 : 0xDA}))
        (if (i32.eq (local.get $mode) (i32.const 0x0E))
          (then (local.set $h (i32.const 240)) (global.set $vcmax (i32.const ${opts.pal ? 0x10A : 0x106}))))
        (if (i32.eq (local.get $mode) (i32.const 0x16))
          (then (local.set $h (i32.const 224)) (global.set $vcmax (i32.const ${opts.pal ? 0x102 : 0xEA}))))
        (if (i32.ne (local.get $h) (global.get $vph)) (then (global.set $vpchanged (i32.const 1))))))`})

  ;; system_frame_sms: a pending height change takes effect as a frame starts
  (func $vdp_frame_start
    (local $mode i32)
    (if (global.get $vpchanged)
      (then (global.set $vpchanged (i32.const 0))
            (local.set $mode (i32.or (i32.and (call $vreg (i32.const 0)) (i32.const 6)) (i32.and (call $vreg (i32.const 1)) (i32.const 0x18))))
            (global.set $vph (select (i32.const 240) (select (i32.const 224) (i32.const 192) (i32.eq (local.get $mode) (i32.const 0x16)))
                                     (i32.eq (local.get $mode) (i32.const 0x0E)))))))
  (global $fmstatus (mut i32) (i32.const 0))

  (func $ioctl_write (param $v i32)
    (if (i32.or (i32.and (i32.eqz (i32.and (global.get $ioctl) (i32.const 0x80))) (i32.ne (i32.and (local.get $v) (i32.const 0x80)) (i32.const 0)))
                (i32.and (i32.eqz (i32.and (global.get $ioctl) (i32.const 0x20))) (i32.ne (i32.and (local.get $v) (i32.const 0x20)) (i32.const 0))))
      (then (global.set $hvlatch (i32.or (i32.const 0x10000)
              (i32.load8_u (i32.add (i32.const ${HLATTAB}) (i32.rem_u ${tInLine} (i32.const 228))))))))
    (global.set $ioctl ${japan ? "(i32.and (local.get $v) (i32.const 0x0F))" : "(local.get $v)"}))

  (global $earlyline (mut i32) (i32.const -1))
  (func $vdp_status_read (result i32)
    (local $s i32) (local $vl i32) (local $nl i32) (local $t i32) (local $hc i32)
    ;; vdp_z80_ctrl_r treats bit 1 as the Mega Drive's DMA busy flag and
    ;; clears it (no DMA pending) before anything else: a TMS fifth-sprite
    ;; number with bit 1 set reads back without it unless the next line is
    ;; rendered (and parsed) by this read
    (global.set $vdp_status (i32.and (global.get $vdp_status) (i32.const 0xFD)))
    (local.set $vl (global.get $line))
    (if (i32.le_s (global.get $curbudget) (i32.const 0))
      (then
        (if (i32.eq (global.get $line) (global.get $vph))
          (then
            (if (i32.eqz (global.get $vintdone))
              (then (global.set $vintdone (i32.const 1))
                    (global.set $vdp_status (i32.or (global.get $vdp_status) (i32.const 0x80))))))
          (else
            ;; gpgx renders the next line NOW (cycle-accurate collision flags)
            (local.set $nl (i32.rem_u (i32.add (global.get $line) (i32.const 1)) (i32.const ${LINES})))
            (if (i32.lt_u (local.get $nl) (global.get $vph))
              (then
                (if (i32.ne (global.get $earlyline) (local.get $nl))
                  (then (call $render_line (local.get $nl))
                        (global.set $earlyline (local.get $nl))))
                (local.set $vl (local.get $nl))))))))
    (local.set $s (global.get $vdp_status))
    (if (i32.and (call $vreg (i32.const 0)) (i32.const 0x04))
      (then (local.set $s (i32.or (local.get $s) (i32.const 0x1F)))))
    (global.set $vdp_status (i32.and (global.get $vdp_status) (i32.const 0x1F)))
    ;; A collision on the current line is visible only once the beam is past it.
    (if (i32.and (i32.ne (i32.and (local.get $s) (i32.const 0x20)) (i32.const 0))
                 (i32.eq (local.get $vl) (i32.shr_u (global.get $sprcol) (i32.const 8))))
      (then
        (local.set $t (select (i32.sub (i32.const 228) (global.get $curbudget))
                              (i32.sub (i32.const 0) (global.get $curbudget))
                              (i32.gt_s (global.get $curbudget) (i32.const 0))))
        (local.set $hc (i32.load8_u (i32.add (i32.const ${HCOLTAB}) (i32.rem_u (local.get $t) (i32.const 228)))))
        (if (i32.or (i32.lt_u (local.get $hc) (i32.and (global.get $sprcol) (i32.const 0xFF)))
                    (i32.gt_u (local.get $hc) (i32.const 0xF3)))
          (then (global.set $vdp_status (i32.or (global.get $vdp_status) (i32.const 0x20)))
                (local.set $s (i32.and (local.get $s) (i32.const 0xDF)))))))
    (global.set $hintpend (i32.const 0))
    (global.set $vdp_first (i32.const 1))
    (local.get $s))

  (func $vreg (param $n i32) (result i32)
    (i32.load8_u (i32.add (i32.const ${VREG}) (local.get $n))))

  (func $vcounter (result i32)
    (local $vc i32)
    (local.set $vc (global.get $line))
    (if (i32.le_s (global.get $curbudget) (i32.const 0))
      (then (local.set $vc (i32.rem_u (i32.add (local.get $vc) (i32.const 1)) (i32.const ${LINES})))))
    (if (i32.gt_u (local.get $vc) (global.get $vcmax))
      (then (local.set $vc (i32.sub (local.get $vc) (i32.const ${LINES})))))
    (i32.and (local.get $vc) (i32.const 0xFF)))

  ;; gpgx vdp_hvc_r in Mode 4: the latched H counter (live only on the
  ;; Mega Drive VDP in Mode 5).
  (func $hcounter (result i32)
    (i32.and (global.get $hvlatch) (i32.const 0xFF)))

  ;; io_z80_read: TH A/B and TR B read the written level only as outputs
  (func $port_dd (result i32)
    (local $d i32)
    (local.set $d (i32.or (i32.and (global.get $joy2) (i32.const 0x3F))
      (i32.or (select (i32.const 0x40) (i32.shl (i32.and (global.get $ioctl) (i32.const 0x20)) (i32.const 1))
                      (i32.and (global.get $ioctl) (i32.const 0x02)))
              (select (i32.const 0x80) (i32.and (global.get $ioctl) (i32.const 0x80))
                      (i32.and (global.get $ioctl) (i32.const 0x08))))))
    (if (i32.eqz (i32.and (global.get $ioctl) (i32.const 0x04)))
      (then (local.set $d (i32.or (i32.and (local.get $d) (i32.const 0xF7))
              (i32.shr_u (i32.and (global.get $ioctl) (i32.const 0x40)) (i32.const 3))))))
    (local.get $d))
  ;; ...and TR A on port $DC
  (func $port_dc (result i32)
    (if (result i32) (i32.and (global.get $ioctl) (i32.const 0x01))
      (then (global.get $joy1))
      (else (i32.or (i32.and (global.get $joy1) (i32.const 0xDF))
                    (i32.shl (i32.and (global.get $ioctl) (i32.const 0x10)) (i32.const 1))))))

  (func $io_write (param $port i32) (param $v i32)
    (local $p i32) (local $g i32)
    (local.set $p (i32.and (local.get $port) (i32.const 0xFF)))
    (local.set $g (i32.and (local.get $p) (i32.const 0xC1)))
    (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
    (if (i32.lt_u (local.get $g) (i32.const 0x40))
      (then
${gg && opts.ggms ? `        ;; z80_gg_port_w: $00-$06 reach the GG registers only in GG mode
        (if (i32.eq (local.get $p) (i32.const 0x3E)) (then (global.set $memctl (local.get $v)) (return)))
        (if (i32.eq (local.get $p) (i32.const 0x3F)) (then ${IOCTL_W} (return)))
        (return)))` : gg ? `        (if (i32.lt_u (local.get $p) (i32.const 7))
          (then
            (if (i32.or (i32.eq (local.get $p) (i32.const 1))
                        (i32.or (i32.eq (local.get $p) (i32.const 2)) (i32.eq (local.get $p) (i32.const 3))))
              (then (i32.store8 (i32.add (i32.const ${IOREGS}) (local.get $p)) (local.get $v))))
            (if (i32.eq (local.get $p) (i32.const 5))
              (then (i32.store8 (i32.const ${IOREGS + 5}) (i32.and (local.get $v) (i32.const 0xF8)))))
            (if (i32.eq (local.get $p) (i32.const 6))
              (then (i32.store8 (i32.const ${IOREGS + 6}) (local.get $v))
                    ;; io_gg_write: psg_config(Z80.cycles, psg_preamp, data) (psg.js)
                    (call $psg_stereo (local.get $v))))
            (return)))
        (if (i32.eq (local.get $p) (i32.const 0x3E)) (then (global.set $memctl (local.get $v)) (return)))
        (if (i32.eq (local.get $p) (i32.const 0x3F)) (then ${IOCTL_W} (return)))
        (return)))`
    : japan ? `        (if (i32.eq (local.get $p) (i32.const 0x3E)) (then (global.set $memctl (local.get $v)) (return)))
        (if (i32.eq (local.get $p) (i32.const 0x3F)) (then ${IOCTL_W} (return)))
        (return)))`
    : `        (if (i32.and (local.get $p) (i32.const 1))
          (then ${IOCTL_W})
          (else (global.set $memctl (local.get $v))))
        (return)))`}
    (if (i32.lt_u (local.get $g) (i32.const 0x80)) (then (call $psg_write (local.get $v)) (return)))
    (if (i32.eq (local.get $g) (i32.const 0x80)) (then (call $vdp_data_write (local.get $v)) (return)))
    (if (i32.eq (local.get $g) (i32.const 0x81)) (then (call $vdp_ctrl_write (local.get $v)) (return)))
${gg ? "" : japan ? `    ;; 315-5297: the FM audio control register at $F2 (FM is on for a Japanese console)
    (if (i32.eq (local.get $p) (i32.const 0xF2))
      (then (global.set $io6 (local.get $v)) (global.set $fmstatus (i32.and (local.get $v) (i32.const 1)))))`
    : opts.fm ? `    ;; external FM unit: bit 1 selects its output control register
    (if (i32.eqz (i32.and (local.get $p) (i32.const 4)))
      (then (if (i32.and (local.get $p) (i32.const 2)) (then (global.set $fmstatus (i32.and (local.get $v) (i32.const 1)))))))` : ""})

  (func $io_read (param $port i32) (result i32)
    (local $p i32) (local $g i32)
    (local.set $p (i32.and (local.get $port) (i32.const 0xFF)))
    (local.set $g (i32.and (local.get $p) (i32.const 0xC1)))
    (if (i32.eq (local.get $g) (i32.const 0x40)) (then (return (call $vcounter))))
    (if (i32.eq (local.get $g) (i32.const 0x41)) (then (return (call $hcounter))))
    (if (i32.eq (local.get $g) (i32.const 0x80)) (then (return (call $vdp_data_read))))
    (if (i32.eq (local.get $g) (i32.const 0x81)) (then (return (call $vdp_status_read))))
${gg ? `    (if (i32.lt_u (local.get $g) (i32.const 0x40))
      (then${opts.ggms ? `
        ;; z80_gg_port_r: no GG registers in SMS mode, an unused read is $FF
        (return (i32.const 0xFF))))` : `
        (if (i32.eqz (local.get $p))
          (then (return (i32.and (i32.load8_u (i32.const ${IOREGS}))
                                 (i32.xor (i32.xor (global.get $ggstart) (i32.const 0x80)) (i32.const 0xFF))))))
        (if (i32.eq (local.get $p) (i32.const 1))
          (then (return (i32.or (i32.and (i32.load8_u (i32.const ${IOREGS + 1}))
                                         (i32.xor (i32.and (i32.load8_u (i32.const ${IOREGS + 2})) (i32.const 0x7F)) (i32.const 0xFF)))
                                (i32.and (i32.load8_u (i32.const ${IOREGS + 2})) (i32.const 0x7F))))))
        (if (i32.lt_u (local.get $p) (i32.const 6))
          (then (return (i32.load8_u (i32.add (i32.const ${IOREGS}) (local.get $p))))))
        (return (i32.const 0xFF))))`}
    (if (i32.or (i32.eq (local.get $p) (i32.const 0xC0)) (i32.eq (local.get $p) (i32.const 0xDC)))
      (then (return (call $port_dc))))
    (if (i32.or (i32.eq (local.get $p) (i32.const 0xC1)) (i32.eq (local.get $p) (i32.const 0xDD)))
      (then (return (call $port_dd))))
    (i32.const 0xFF))`
    : japan ? `    (if (i32.lt_u (local.get $g) (i32.const 0x40)) (then (return (i32.const 0xFF))))
    (if (i32.eq (local.get $p) (i32.const 0xF2)) (then (return (i32.and (global.get $io6) (i32.const 3)))))
    (if (i32.or (i32.eq (local.get $p) (i32.const 0xC0)) (i32.eq (local.get $p) (i32.const 0xDC)))
      (then (return (select (i32.const 0xFF) (call $port_dc) (i32.and (global.get $memctl) (i32.const 0x04))))))
    (if (i32.or (i32.eq (local.get $p) (i32.const 0xC1)) (i32.eq (local.get $p) (i32.const 0xDD)))
      (then (return (select (i32.const 0xFF) (call $port_dd) (i32.and (global.get $memctl) (i32.const 0x04))))))
    (i32.const 0xFF))`
    : `    (local.set $g (i32.const 0xFF))
    (if (i32.lt_u (i32.and (local.get $p) (i32.const 0xC1)) (i32.const 0x40)) (then (return (i32.const 0xFF))))
${opts.fm ? `    (if (i32.eqz (i32.and (local.get $p) (i32.const 4))) (then (local.set $g (i32.or (i32.const 0xF8) (global.get $fmstatus)))))
` : ""}    (if (i32.eqz (i32.and (global.get $memctl) (i32.const 0x04)))
      (then (local.set $g (i32.and (local.get $g)
              (if (result i32) (i32.and (local.get $p) (i32.const 1)) (then (call $port_dd)) (else (call $port_dc)))))))
    (local.get $g))`}
${ggVdp ? `  (data (i32.const ${IOREGS}) "${[io0, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF].map((b) => "\\" + b.toString(16).padStart(2, "0")).join("")}")
` : ""}`;
}

/**
 * gpgx's H counter per T-state of a 228-T line (its cycle2hc32 table taken
 * every 15 master cycles, generated by scripts/recompile-gen/sms-hcounter.mjs).
 * @returns {Uint8Array}
 */
export function hcounterBytes() {
  return Uint8Array.from(HC_TABLE);
}

/** @returns {Uint8Array} the H counter a TH latch captures, by T-state (228 bytes) */
export function hlatchBytes() {
  return Uint8Array.from(HLAT_TABLE);
}

/** @returns {Uint8Array} the collision-check H counter table (228 bytes) */
export function hcolBytes() {
  return Uint8Array.from(HCOL_TABLE);
}

/**
 * Mode 4 scanline renderer into the index buffer at SMSFB: background with
 * H/V scroll (vertical wraps at 224, R0 bit 6/7 scroll locks), priority
 * tiles, up to 8 sprites per line (8x16 via R1 bit 1, R0 bit 3 shift, lower
 * sprite wins an overlap), display blank (R1 bit 6) and the left-column mask
 * (R0 bit 5) in the backdrop colour. Bit 7 of an index marks a priority BG
 * pixel and bit 6 a sprite-claimed one while the line is built.
 */
export function renderWat(opts = {}) {
  let text = renderLegacyWat();
  if (!opts.exact) return text;
  // Sprites as genesis_plus_gx's parse_satb_m4 / render_obj_m4 draw them:
  // Y past 208 wraps to the top, zoom (R1 bit 0) doubles pixels and rows,
  // a 9th sprite on an active line sets the overflow flag (status bit 6),
  // and two sprites' opaque pixels meeting set the collision flag (bit 5),
  // with the x of the first collision kept for the cycle-accurate status
  // read (spr_col).
  const start = text.indexOf("    (local.set $i (i32.const 0))\n    (local.set $drawn (i32.const 0))");
  const endMark = "      (br $sp)))\n";
  const end = text.indexOf(endMark, start) + endMark.length;
  if (start < 0 || end < endMark.length) throw new Error("sms recompile: sprite section not found in the renderer text");
  const sprites = `    (global.set $vdp_status (i32.or (global.get $vdp_status) (global.get $sprovr)))
    (global.set $sprovr (i32.const 0))
    (local.set $zoom (i32.and (call $vreg (i32.const 1)) (i32.const 1)))
    (local.set $i (i32.const 0))
    (block $spdone (loop $sp
      (br_if $spdone (i32.ge_u (local.get $i) (i32.load8_u (i32.const ${OBJLIST}))))
      (local.set $sxx (i32.sub (i32.load8_u (i32.add (i32.const ${OBJLIST + 4}) (i32.shl (local.get $i) (i32.const 2))))
                               (i32.and (call $vreg (i32.const 0)) (i32.const 8))))
      (local.set $stile (i32.load8_u (i32.add (i32.const ${OBJLIST + 5}) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $py (i32.load8_u (i32.add (i32.const ${OBJLIST + 6}) (i32.shl (local.get $i) (i32.const 2)))))
      (if (i32.and (call $vreg (i32.const 6)) (i32.const 4))
        (then (local.set $stile (i32.add (local.get $stile) (i32.const 256)))))
${opts.sms1 ? `      ;; 315-5124: R6 bits 0-1 mask pattern bits 6-7 (render_obj_m4 sg_mask),
      ;; and the last four sprites of a line are never zoomed
      (local.set $stile (i32.and (local.get $stile) (i32.or (i32.const 0x13F) (i32.shl (i32.and (call $vreg (i32.const 6)) (i32.const 3)) (i32.const 6)))))
      (local.set $sz (select (local.get $zoom) (i32.const 0) (i32.lt_u (i32.add (local.get $i) (i32.const 4)) (i32.load8_u (i32.const ${OBJLIST})))))
` : `      (local.set $sz (local.get $zoom))
`}      (if (i32.ge_u (local.get $py) (i32.const 8))
        (then (local.set $stile (i32.add (local.get $stile) (i32.const 1)))
              (local.set $py (i32.sub (local.get $py) (i32.const 8)))))
      (local.set $px (i32.const 0))
      (block $sdone (loop $spx
        (br_if $sdone (i32.ge_u (local.get $px) (i32.shl (i32.const 8) (local.get $sz))))
        (local.set $x (i32.add (local.get $sxx) (local.get $px)))
        (if (i32.and (i32.ge_s (local.get $x) (i32.const 0)) (i32.lt_s (local.get $x) (i32.const 256)))
          (then
            (local.set $c (call $tile_pixel (local.get $stile) (i32.shr_u (local.get $px) (local.get $sz)) (local.get $py)))
            (local.set $o (i32.load8_u (i32.add (local.get $fbrow) (local.get $x))))
            (if (i32.ne (local.get $c) (i32.const 0))
              (then
                (if (i32.and (local.get $o) (i32.const 0x40))
                  (then
                    (if (i32.eqz (i32.and (global.get $vdp_status) (i32.const 0x20)))
                      (then (global.set $vdp_status (i32.or (global.get $vdp_status) (i32.const 0x20)))
                            (global.set $sprcol (i32.or (i32.shl (local.get $y) (i32.const 8))
                              (i32.shr_u (i32.add (local.get $x) (i32.const 13)) (i32.const 1)))))))
                  (else
                    (if (i32.and (local.get $o) (i32.const 0x80))
                      (then (i32.store8 (i32.add (local.get $fbrow) (local.get $x))
                                        (i32.or (local.get $o) (i32.const 0x40))))
                      (else (i32.store8 (i32.add (local.get $fbrow) (local.get $x))
                                        (i32.or (local.get $c) (i32.const 0x50)))))))))))
        (local.set $px (i32.add (local.get $px) (i32.const 1)))
        (br $spx)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sp)))
    (if (i32.lt_u (local.get $y) (i32.sub (global.get $vph) (i32.const 1))) (then (call $parse_satb (local.get $y))))
`;
  // gpgx latches R9 (vertical scroll) once a frame, after the last line
  // runs; the cart kept reading the live register on every line.
  const vsOld = "(local.set $sy (i32.add (local.get $y) (call $vreg (i32.const 9))))";
  if (!text.includes(vsOld)) throw new Error("sms recompile: vertical scroll read not found in the renderer text");
  text = text.replace(vsOld, "(local.set $sy (i32.add (local.get $y) (global.get $vscroll)))");
  // gpgx render_bg_m4: the name table row address through its mask (R2
  // bits 1-3, bit 0 too on the 315-5124 VDP), and the extended heights'
  // 32-row table at $3700 with a 256-line vertical wrap.
  const must = (a, b) => { if (!text.includes(a)) throw new Error(`sms recompile: renderer text not found: ${a.slice(0, 60)}`); text = text.replace(a, b); };
  must(`    (if (i32.ge_u (local.get $sy) (i32.const 224))
      (then (local.set $sy (i32.sub (local.get $sy) (i32.const 224)))))`, `    (local.set $sy (select (i32.and (local.get $sy) (i32.const 255)) (i32.rem_u (local.get $sy) (i32.const 224))
                           (i32.gt_u (global.get $vph) (i32.const 192))))
    (local.set $ntbase (i32.or (i32.xor (i32.const 0xFFFFC3FF) (i32.shl (call $vreg (i32.const 2)) (i32.const 10)))
                               (i32.const ${opts.sms1 ? 0 : 0x400})))`);
  must(`      (local.set $ent (i32.add (i32.add (i32.const ${VRAM}) (local.get $ntbase))
        (i32.mul (i32.add (i32.mul (local.get $row) (i32.const 32)) (local.get $tx)) (i32.const 2))))`,
  `      (local.set $ent (i32.add (i32.const ${VRAM})
        (i32.add (select (i32.add (i32.and (i32.const 0x3700) (local.get $ntbase)) (i32.shl (local.get $row) (i32.const 6)))
                         (i32.and (i32.add (i32.const 0x3800) (i32.shl (local.get $row) (i32.const 6))) (local.get $ntbase))
                         (i32.gt_u (global.get $vph) (i32.const 192)))
                 (i32.shl (local.get $tx) (i32.const 1)))))`);
  // the line probe has 192 slots: taller modes share the last one
  must(`    (local.set $lp (i32.add (i32.const ${LINEPROBE}) (i32.mul (local.get $y) (i32.const 8))))`,
    `    (local.set $lp (i32.add (i32.const ${LINEPROBE}) (i32.mul (select (local.get $y) (i32.const 191) (i32.lt_u (local.get $y) (i32.const 192))) (i32.const 8))))`);

  // 315-5124: bitplanes 0-1 of a background tile are fetched with the tile
  // index masked by R3 (bits 1-8), bitplanes 2-3 with it masked by R4 bits
  // 0-2 (bits 6-8), as render_bg_m4 does on that VDP.
  if (opts.sms1) must(`        (local.set $c (call $tile_pixel (local.get $tile)`, `        (local.set $c (call $tile_pixel_s1 (local.get $tile)`);
  // M4 clear (R0 bit 2): the TMS9918 modes (tmsWat)
  const withLocals = text.replace("(local $r0 i32) (local $hs i32) (local $bd i32) (local $o i32)\n",
    "(local $r0 i32) (local $hs i32) (local $bd i32) (local $o i32) (local $zoom i32) (local $sz i32)\n" +
    "    (if (i32.eqz (i32.and (call $vreg (i32.const 0)) (i32.const 4))) (then (call $render_line_tms (local.get $y)) (return)))\n");
  if (withLocals === text) throw new Error("sms recompile: renderer locals not found");
  const s2 = withLocals.indexOf("    (local.set $i (i32.const 0))\n    (local.set $drawn (i32.const 0))");
  const e2 = withLocals.indexOf(endMark, s2) + endMark.length;
  const blankOld = "          (br $bkl)))\n        (return)))";
  const body = withLocals.slice(0, s2) + sprites + withLocals.slice(e2);
  if (!body.includes(blankOld)) throw new Error("sms recompile: blank-display path not found in the renderer text");
  const withBlank = body.replace(blankOld, `          (br $bkl)))
        (global.set $vdp_status (i32.or (global.get $vdp_status) (global.get $sprovr)))
        (global.set $sprovr (i32.const 0))
        (call $parse_satb (local.get $y))
        (return)))`);
  return `${opts.sms1 ? `
  (func $tile_pixel_s1 (param $tile i32) (param $px i32) (param $py i32) (result i32)
    (i32.or
      (i32.and (call $tile_pixel (i32.and (local.get $tile) (i32.or (i32.const 1) (i32.shl (call $vreg (i32.const 3)) (i32.const 1)))) (local.get $px) (local.get $py)) (i32.const 3))
      (i32.and (call $tile_pixel (i32.and (local.get $tile) (i32.or (i32.const 0x3F) (i32.shl (i32.and (call $vreg (i32.const 4)) (i32.const 7)) (i32.const 6)))) (local.get $px) (local.get $py)) (i32.const 12))))
` : ""}${tmsWat(opts)}
  (global $sprcol (mut i32) (i32.const 0))
  (global $sprovr (mut i32) (i32.const 0))
  (func $parse_satb (param $line i32)
    (if (i32.and (call $vreg (i32.const 0)) (i32.const 4))
      (then (call $parse_satb_m4 (local.get $line)))
      (else (call $parse_satb_tms (local.get $line)))))
  (func $parse_satb_m4 (param $line i32)
    (local $i i32) (local $cnt i32) (local $satb i32) (local $sy i32) (local $py i32) (local $h16 i32) (local $zoom i32) (local $stm i32)
    ;; st_mask: on the 315-5124 VDP R5 bit 0 masks bit 7 of the x/pattern offset
    (local.set $stm ${opts.sms1 ? "(i32.or (i32.const 0x7F) (i32.shl (i32.and (call $vreg (i32.const 5)) (i32.const 1)) (i32.const 7)))" : "(i32.const 0xFF)"})
    (local.set $satb (i32.shl (i32.and (call $vreg (i32.const 5)) (i32.const 0x7E)) (i32.const 7)))
    (local.set $h16 (i32.and (call $vreg (i32.const 1)) (i32.const 2)))
    (local.set $zoom (i32.and (call $vreg (i32.const 1)) (i32.const 1)))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (i32.const 64)))
      (local.set $sy (i32.load8_u (i32.add (i32.const ${VRAM}) (i32.add (local.get $satb) (local.get $i)))))
      (br_if $done (i32.and (i32.eq (local.get $sy) (i32.const 208)) (i32.eq (global.get $vph) (i32.const 192))))
      (if (i32.gt_u (local.get $sy) (i32.add (global.get $vph) (i32.const 16))) (then (local.set $sy (i32.sub (local.get $sy) (i32.const 256)))))
      (local.set $py (i32.shr_s (i32.sub (local.get $line) (local.get $sy)) (local.get $zoom)))
      (if (i32.and (i32.ge_s (local.get $py) (i32.const 0))
                   (i32.lt_s (local.get $py) (select (i32.const 16) (i32.const 8) (local.get $h16))))
        (then
          (if (i32.eq (local.get $cnt) (i32.const 8))
            (then
              (if (i32.and (i32.ge_s (local.get $line) (i32.const 0)) (i32.lt_s (local.get $line) (global.get $vph)))
                (then (global.set $sprovr (i32.const 0x40))))
              (br $done)))
          (i32.store8 (i32.add (i32.const ${OBJLIST + 4}) (i32.shl (local.get $cnt) (i32.const 2)))
            (i32.load8_u (i32.add (i32.const ${VRAM}) (i32.add (local.get $satb) (i32.and (i32.add (i32.const 128) (i32.shl (local.get $i) (i32.const 1))) (local.get $stm))))))
          (i32.store8 (i32.add (i32.const ${OBJLIST + 5}) (i32.shl (local.get $cnt) (i32.const 2)))
            (i32.and (i32.load8_u (i32.add (i32.const ${VRAM}) (i32.add (local.get $satb) (i32.and (i32.add (i32.const 129) (i32.shl (local.get $i) (i32.const 1))) (local.get $stm)))))
                     (select (i32.const 0xFE) (i32.const 0xFF) (local.get $h16))))
          (i32.store8 (i32.add (i32.const ${OBJLIST + 6}) (i32.shl (local.get $cnt) (i32.const 2))) (local.get $py))
          (local.set $cnt (i32.add (local.get $cnt) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store8 (i32.const ${OBJLIST}) (local.get $cnt)))
` + withBlank;
}

/**
 * The TMS9918 modes (R0 bit 2 clear) as genesis_plus_gx renders them on the
 * Master System and Game Gear VDPs: Graphics I and II, Text, Multicolor
 * (with the extended pattern tables when M2 is also set), the invalid
 * combinations, and the TMS sprites (four a line, early clock, 16x16 and
 * zoom, the fifth-sprite number in the status low bits, a collision whenever
 * a sprite covers a pixel an earlier sprite drew). A line is built with
 * gpgx's line-buffer codes (0x10 | colour, 0x40 border, bit 7 = a sprite drew
 * here) and stored as a frame index: on the Master System the colours are the
 * fixed tms_crom set (index 0x20 | n, looked up in TMSCROM at present time),
 * on the Game Gear (and a Game Gear in SMS mode) CRAM palette 1 (0x10 | n);
 * colour 0 and the borders show the backdrop, R7's low nibble.
 * @param {{sms1?: boolean, tmsBase?: number}} opts
 */
function tmsWat(opts) {
  const base = opts.tmsBase ?? 0x20;
  // "unused bits used as a mask on TMS99xx & 315-5124 VDP only": the others OR them in
  const ext = (m) => (opts.sms1 ? "" : ` (i32.const ${m})`);
  const orExt = (e, m) => (opts.sms1 ? e : `(i32.or ${e}${ext(m)})`);
  const R = (n) => `(call $vreg (i32.const ${n}))`;
  return `
  (data (i32.const ${TMSCROM}) "${TMS_CROM.map((b) => "\\" + b.toString(16).padStart(2, "0")).join("")}")
  (func $vr (param $a i32) (result i32)
    (if (result i32) (i32.lt_u (local.get $a) (i32.const 0x4000))
      (then (i32.load8_u (i32.add (i32.const ${VRAM}) (local.get $a))))
      (else (i32.const 0))))
  ;; n pixels (8, or 6 in the Text modes) of one pattern byte: 0x10 | the colour
  ;; byte's high nibble for a set bit, its low nibble for a clear one
  (func $tms_put (param $dst i32) (param $color i32) (param $pat i32) (param $n i32)
    (local $k i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $k) (local.get $n)))
      (i32.store8 (i32.add (local.get $dst) (local.get $k))
        (i32.or (i32.const 0x10) (i32.and (i32.shr_u (local.get $color)
          (i32.shl (i32.and (i32.shr_u (local.get $pat) (i32.sub (i32.const 7) (local.get $k))) (i32.const 1)) (i32.const 2))) (i32.const 15))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l))))
  (func $tms_fill (param $dst i32) (param $v i32) (param $n i32)
    (memory.fill (local.get $dst) (local.get $v) (local.get $n)))

  ;; render_bg_m0..m3 / m1x / m3x / inv into the line row
  (func $tms_bg (param $y i32) (param $row i32)
    (local $mode i32) (local $nt i32) (local $ct i32) (local $pg i32) (local $col i32) (local $name i32)
    (local $ctm i32) (local $pgm i32) (local $color i32) (local $dst i32)
    (local.set $mode (i32.shr_u (i32.or (i32.and ${R(0)} (i32.const 6)) (i32.and ${R(1)} (i32.const 0x18))) (i32.const 1)))
    (local.set $ctm ${orExt(`(i32.and (i32.xor (i32.const 0xC03F) (i32.shl ${R(3)} (i32.const 6))) (i32.const 0xFFFF))`, 0x1FC0)})
    (local.set $pgm ${orExt(`(i32.and (i32.xor (i32.const 0xC7FF) (i32.shl ${R(4)} (i32.const 11))) (i32.const 0xFFFF))`, 0x1800)})
    ;; Text modes: 8-pixel borders, 40 x 6 pixels
    (if (i32.eq (i32.and (local.get $mode) (i32.const 0xC)) (i32.const 8))
      (then
        (local.set $color ${R(7)})
        (call $tms_fill (local.get $row) (i32.const 0x40) (i32.const 8))
        (call $tms_fill (i32.add (local.get $row) (i32.const 248)) (i32.const 0x40) (i32.const 8))
        (local.set $nt (i32.add (i32.and (i32.shl ${R(2)} (i32.const 10)) (i32.const 0x3C00)) (i32.mul (i32.shr_u (local.get $y) (i32.const 3)) (i32.const 40))))
        (local.set $pg (if (result i32) (i32.and (local.get $mode) (i32.const 1))
          (then (i32.add (i32.and (i32.add (i32.const 0x2000) (i32.shl (i32.and (local.get $y) (i32.const 0xC0)) (i32.const 5))) (local.get $pgm)) (i32.and (local.get $y) (i32.const 7))))
          (else (i32.add (i32.and (i32.shl ${R(4)} (i32.const 11)) (i32.const 0x3800)) (i32.and (local.get $y) (i32.const 7))))))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $col) (i32.const 40)))
          (call $tms_put (i32.add (local.get $row) (i32.add (i32.const 8) (i32.mul (local.get $col) (i32.const 6))))
            (local.get $color) (call $vr (i32.add (local.get $pg) (i32.shl (call $vr (i32.add (local.get $nt) (local.get $col))) (i32.const 3)))) (i32.const 6))
          (local.set $col (i32.add (local.get $col) (i32.const 1)))
          (br $l)))
        (return)))
    ;; M1 + M3 (with or without M2): invalid, R7's two nibbles in 4 + 2 pixel runs
    (if (i32.eq (i32.and (local.get $mode) (i32.const 0xC)) (i32.const 12))
      (then
        (local.set $color ${R(7)})
        (call $tms_fill (local.get $row) (i32.const 0x40) (i32.const 8))
        (call $tms_fill (i32.add (local.get $row) (i32.const 248)) (i32.const 0x40) (i32.const 8))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $col) (i32.const 40)))
          (local.set $dst (i32.add (local.get $row) (i32.add (i32.const 8) (i32.mul (local.get $col) (i32.const 6)))))
          (call $tms_fill (local.get $dst) (i32.or (i32.const 0x10) (i32.and (i32.shr_u (local.get $color) (i32.const 4)) (i32.const 15))) (i32.const 4))
          (call $tms_fill (i32.add (local.get $dst) (i32.const 4)) (i32.or (i32.const 0x10) (i32.and (local.get $color) (i32.const 15))) (i32.const 2))
          (local.set $col (i32.add (local.get $col) (i32.const 1)))
          (br $l)))
        (return)))
    (local.set $nt (i32.add (i32.and (i32.shl ${R(2)} (i32.const 10)) (i32.const 0x3C00)) (i32.shl (i32.and (local.get $y) (i32.const 0xF8)) (i32.const 2))))
    ;; Multicolor (M3): 4 x 4-pixel blocks, extended table with M2
    (if (i32.eq (i32.and (local.get $mode) (i32.const 0xC)) (i32.const 4))
      (then
        (local.set $pg (if (result i32) (i32.and (local.get $mode) (i32.const 1))
          (then (i32.add (i32.and (i32.add (i32.const 0x2000) (i32.shl (i32.and (local.get $y) (i32.const 0xC0)) (i32.const 5))) (local.get $pgm)) (i32.and (i32.shr_u (local.get $y) (i32.const 2)) (i32.const 7))))
          (else (i32.add (i32.and (i32.shl ${R(4)} (i32.const 11)) (i32.const 0x3800)) (i32.and (i32.shr_u (local.get $y) (i32.const 2)) (i32.const 7))))))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $col) (i32.const 32)))
          (local.set $color (call $vr (i32.add (local.get $pg) (i32.shl (call $vr (i32.add (local.get $nt) (local.get $col))) (i32.const 3)))))
          (local.set $dst (i32.add (local.get $row) (i32.shl (local.get $col) (i32.const 3))))
          (call $tms_fill (local.get $dst) (i32.or (i32.const 0x10) (i32.and (i32.shr_u (local.get $color) (i32.const 4)) (i32.const 15))) (i32.const 4))
          (call $tms_fill (i32.add (local.get $dst) (i32.const 4)) (i32.or (i32.const 0x10) (i32.and (local.get $color) (i32.const 15))) (i32.const 4))
          (local.set $col (i32.add (local.get $col) (i32.const 1)))
          (br $l)))
        (return)))
    ;; Graphics II (M2): tables split in three by line
    (if (i32.and (local.get $mode) (i32.const 1))
      (then
        (local.set $ct (i32.add (i32.and (i32.add (i32.const 0x2000) (i32.shl (i32.and (local.get $y) (i32.const 0xC0)) (i32.const 5))) (local.get $ctm)) (i32.and (local.get $y) (i32.const 7))))
        (local.set $pg (i32.add (i32.and (i32.add (i32.const 0x2000) (i32.shl (i32.and (local.get $y) (i32.const 0xC0)) (i32.const 5))) (local.get $pgm)) (i32.and (local.get $y) (i32.const 7))))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $col) (i32.const 32)))
          (local.set $name (i32.shl (call $vr (i32.add (local.get $nt) (local.get $col))) (i32.const 3)))
          (call $tms_put (i32.add (local.get $row) (i32.shl (local.get $col) (i32.const 3)))
            (call $vr (i32.add (local.get $ct) (i32.and (local.get $name) (local.get $ctm))))
            (call $vr (i32.add (local.get $pg) (local.get $name))) (i32.const 8))
          (local.set $col (i32.add (local.get $col) (i32.const 1)))
          (br $l)))
        (return)))
    ;; Graphics I
    (local.set $ct (i32.and (i32.shl ${R(3)} (i32.const 6)) (i32.const 0x3FC0)))
    (local.set $pg (i32.add (i32.and (i32.shl ${R(4)} (i32.const 11)) (i32.const 0x3800)) (i32.and (local.get $y) (i32.const 7))))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $col) (i32.const 32)))
      (local.set $name (call $vr (i32.add (local.get $nt) (local.get $col))))
      (call $tms_put (i32.add (local.get $row) (i32.shl (local.get $col) (i32.const 3)))
        (call $vr (i32.add (local.get $ct) (i32.shr_u (local.get $name) (i32.const 3))))
        (call $vr (i32.add (local.get $pg) (i32.shl (local.get $name) (i32.const 3)))) (i32.const 8))
      (local.set $col (i32.add (local.get $col) (i32.const 1)))
      (br $l))))

  ;; parse_satb_tms: up to four sprites for the next line; the number of the
  ;; last entry looked at goes to the status low bits
  (func $parse_satb_tms (param $line i32)
    (local $i i32) (local $cnt i32) (local $st i32) (local $y i32) (local $h i32) (local $e i32)
    (if (i32.eqz (i32.and ${R(1)} (i32.const 0x10)))
      (then
        (local.set $st (i32.and (i32.shl ${R(5)} (i32.const 7)) (i32.const 0x3F80)))
        (local.set $h (i32.shl (i32.const 8) (i32.shr_u (i32.and ${R(1)} (i32.const 2)) (i32.const 1))))
        (block $d (loop $l
          (local.set $y (call $vr (i32.add (local.get $st) (i32.shl (local.get $i) (i32.const 2)))))
          (br_if $d (i32.eq (local.get $y) (i32.const 0xD0)))
          (if (i32.ge_u (local.get $y) (i32.const 224)) (then (local.set $y (i32.sub (local.get $y) (i32.const 256)))))
          (local.set $y (i32.shr_s (i32.sub (local.get $line) (local.get $y)) (i32.and ${R(1)} (i32.const 1))))
          (if (i32.and (i32.ge_s (local.get $y) (i32.const 0)) (i32.lt_s (local.get $y) (local.get $h)))
            (then
              (if (i32.eq (local.get $cnt) (i32.const 4))
                (then (if (i32.lt_s (local.get $line) (global.get $vph)) (then (global.set $sprovr (i32.const 0x40))))
                      (br $d)))
              (local.set $e (i32.add (i32.const ${OBJLIST + 4}) (i32.shl (local.get $cnt) (i32.const 2))))
              (i32.store8 (local.get $e) (call $vr (i32.add (local.get $st) (i32.add (i32.shl (local.get $i) (i32.const 2)) (i32.const 1)))))
              (i32.store8 offset=1 (local.get $e) (call $vr (i32.add (local.get $st) (i32.add (i32.shl (local.get $i) (i32.const 2)) (i32.const 2)))))
              (i32.store8 offset=2 (local.get $e) (local.get $y))
              (i32.store8 offset=3 (local.get $e) (call $vr (i32.add (local.get $st) (i32.add (i32.shl (local.get $i) (i32.const 2)) (i32.const 3)))))
              (local.set $cnt (i32.add (local.get $cnt) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (i32.const 32)))))))
    (i32.store8 (i32.const ${OBJLIST}) (local.get $cnt))
    (global.set $vdp_status (i32.or (i32.and (global.get $vdp_status) (i32.const 0xE0)) (i32.and (local.get $i) (i32.const 0x1F)))))

  ;; lut[5] on one line-buffer pixel: a pixel an earlier sprite drew (bit 7)
  ;; keeps it and flags a collision; an opaque sprite pixel wins otherwise
  (func $tms_obj_px (param $a i32) (param $s i32)
    (local $bx i32)
    (local.set $bx (i32.load8_u (local.get $a)))
    (if (i32.and (local.get $bx) (i32.const 0x80))
      (then (global.set $vdp_status (i32.or (global.get $vdp_status) (i32.const 0x20))))
      (else (if (local.get $s) (then (i32.store8 (local.get $a) (i32.or (i32.const 0x90) (local.get $s))))))))

  ;; render_obj_tms
  (func $tms_obj (param $row i32)
    (local $i i32) (local $w i32) (local $zoom i32) (local $e i32) (local $start i32) (local $end i32) (local $x i32)
    (local $size i32) (local $color i32) (local $name i32) (local $sg i32) (local $p0 i32) (local $p1 i32) (local $s i32)
    (local.set $zoom (i32.and ${R(1)} (i32.const 1)))
    (local.set $w (i32.shl (i32.shl (i32.const 8) (i32.shr_u (i32.and ${R(1)} (i32.const 2)) (i32.const 1))) (local.get $zoom)))
    (global.set $vdp_status (i32.or (global.get $vdp_status) (global.get $sprovr)))
    (global.set $sprovr (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.load8_u (i32.const ${OBJLIST}))))
      (local.set $e (i32.add (i32.const ${OBJLIST + 4}) (i32.shl (local.get $i) (i32.const 2))))
      (local.set $size (i32.load8_u offset=3 (local.get $e)))
      (local.set $start (i32.sub (i32.load8_u (local.get $e)) (i32.shr_u (i32.and (local.get $size) (i32.const 0x80)) (i32.const 2))))
      (if (i32.gt_s (i32.add (local.get $start) (local.get $w)) (i32.const 256))
        (then (local.set $end (i32.sub (i32.const 256) (local.get $start))) (local.set $x (i32.const 0)))
        (else (local.set $end (local.get $w))
              (local.set $x (select (i32.sub (i32.const 0) (local.get $start)) (i32.const 0) (i32.lt_s (local.get $start) (i32.const 0))))))
      (local.set $color (i32.and (local.get $size) (i32.const 15)))
      (local.set $name (i32.load8_u offset=1 (local.get $e)))
      (if (i32.and ${R(1)} (i32.const 2)) (then (local.set $name (i32.and (local.get $name) (i32.const 0xFC)))))
      (local.set $sg (i32.or (i32.or (i32.and (i32.shl ${R(6)} (i32.const 11)) (i32.const 0x3800)) (i32.shl (local.get $name) (i32.const 3)))
                             (i32.load8_u offset=2 (local.get $e))))
      (local.set $p0 (call $vr (local.get $sg)))
      (local.set $p1 (call $vr (i32.add (local.get $sg) (i32.const 0x10))))
      (block $xd (loop $xl
        (br_if $xd (i32.ge_s (local.get $x) (local.get $end)))
        (if (local.get $zoom)
          (then
            (local.set $s (i32.mul (i32.and (i32.shr_u (select (local.get $p1) (local.get $p0) (i32.and (i32.shr_u (local.get $x) (i32.const 4)) (i32.const 1)))
                                                       (i32.sub (i32.const 7) (i32.and (i32.shr_u (local.get $x) (i32.const 1)) (i32.const 7)))) (i32.const 1)) (local.get $color)))
            (call $tms_obj_px (i32.add (local.get $row) (i32.add (local.get $start) (local.get $x))) (local.get $s))
            (if (i32.lt_s (i32.add (i32.add (local.get $start) (local.get $x)) (i32.const 1)) (i32.const 256))
              (then (call $tms_obj_px (i32.add (local.get $row) (i32.add (i32.add (local.get $start) (local.get $x)) (i32.const 1))) (local.get $s))))
            (local.set $x (i32.add (local.get $x) (i32.const 2))))
          (else
            (local.set $s (i32.mul (i32.and (i32.shr_u (select (local.get $p1) (local.get $p0) (i32.and (i32.shr_u (local.get $x) (i32.const 3)) (i32.const 1)))
                                                       (i32.sub (i32.const 7) (i32.and (local.get $x) (i32.const 7)))) (i32.const 1)) (local.get $color)))
            (call $tms_obj_px (i32.add (local.get $row) (i32.add (local.get $start) (local.get $x))) (local.get $s))
            (local.set $x (i32.add (local.get $x) (i32.const 1)))))
        (br $xl)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  ;; render_line for the TMS modes; the row ends as frame indices (see tmsWat)
  (func $render_line_tms (param $y i32)
    (local $row i32) (local $x i32) (local $v i32) (local $bd i32)
    (local.set $row (i32.add (i32.const ${SMSFB}) (i32.shl (local.get $y) (i32.const 8))))
    (if (i32.and ${R(1)} (i32.const 0x40))
      (then
        (call $tms_bg (local.get $y) (local.get $row))
        (call $tms_obj (local.get $row))
        (if (i32.and ${R(0)} (i32.const 0x20)) (then (call $tms_fill (local.get $row) (i32.const 0x40) (i32.const 8))))
        (if (i32.lt_s (local.get $y) (i32.sub (global.get $vph) (i32.const 1))) (then (call $parse_satb_tms (local.get $y)))))
      (else
        (global.set $vdp_status (i32.or (global.get $vdp_status) (global.get $sprovr)))
        (global.set $sprovr (i32.const 0))
        (call $parse_satb_tms (local.get $y))
        (call $tms_fill (local.get $row) (i32.const 0x40) (i32.const 256))))
    (local.set $bd (i32.or (i32.const ${base}) (i32.and ${R(7)} (i32.const 15))))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $x) (i32.const 256)))
      (local.set $v (i32.and (i32.load8_u (i32.add (local.get $row) (local.get $x))) (i32.const 15)))
      (i32.store8 (i32.add (local.get $row) (local.get $x)) (select (i32.or (i32.const ${base}) (local.get $v)) (local.get $bd) (local.get $v)))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $l))))
`;
}

function renderLegacyWat() {
  return `
  (func $tile_pixel (param $tile i32) (param $px i32) (param $py i32) (result i32)
    (local $base i32) (local $b i32) (local $sh i32) (local $c i32)
    (local.set $base (i32.add (i32.const ${VRAM})
      (i32.add (i32.mul (local.get $tile) (i32.const 32))
               (i32.mul (local.get $py) (i32.const 4)))))
    (local.set $sh (i32.sub (i32.const 7) (local.get $px)))
    (local.set $c (i32.and (i32.shr_u (i32.load8_u (local.get $base)) (local.get $sh)) (i32.const 1)))
    (local.set $c (i32.or (local.get $c) (i32.shl
      (i32.and (i32.shr_u (i32.load8_u (i32.add (local.get $base) (i32.const 1))) (local.get $sh)) (i32.const 1))
      (i32.const 1))))
    (local.set $c (i32.or (local.get $c) (i32.shl
      (i32.and (i32.shr_u (i32.load8_u (i32.add (local.get $base) (i32.const 2))) (local.get $sh)) (i32.const 1))
      (i32.const 2))))
    (local.set $c (i32.or (local.get $c) (i32.shl
      (i32.and (i32.shr_u (i32.load8_u (i32.add (local.get $base) (i32.const 3))) (local.get $sh)) (i32.const 1))
      (i32.const 3))))
    (local.get $c))

  (func $render_line (param $y i32)
    (local $ntbase i32) (local $sx i32) (local $sy i32) (local $col i32)
    (local $row i32) (local $tx i32) (local $ty i32) (local $ent i32)
    (local $tile i32) (local $attr i32) (local $px i32) (local $py i32)
    (local $c i32) (local $pal i32) (local $x i32) (local $prio i32)
    (local $satb i32) (local $i i32) (local $syy i32) (local $sxx i32)
    (local $stile i32) (local $h16 i32) (local $drawn i32) (local $fbrow i32)
    (local $lp i32) (local $bgnz i32) (local $ntnz i32)
    (local $r0 i32) (local $hs i32) (local $bd i32) (local $o i32)

    (local.set $lp (i32.add (i32.const ${LINEPROBE}) (i32.mul (local.get $y) (i32.const 8))))
    (i32.store8 (i32.add (local.get $lp) (i32.const 0)) (call $vreg (i32.const 1)))
    (i32.store8 (i32.add (local.get $lp) (i32.const 1)) (call $vreg (i32.const 2)))
    (i32.store8 (i32.add (local.get $lp) (i32.const 2)) (call $vreg (i32.const 8)))
    (i32.store8 (i32.add (local.get $lp) (i32.const 3)) (call $vreg (i32.const 9)))

    (local.set $ntbase (i32.shl (i32.and (call $vreg (i32.const 2)) (i32.const 0x0E)) (i32.const 10)))
    (local.set $fbrow (i32.add (i32.const ${SMSFB}) (i32.mul (local.get $y) (i32.const 256))))
    (local.set $r0 (call $vreg (i32.const 0)))
    (local.set $bd (i32.or (i32.const 16) (i32.and (call $vreg (i32.const 7)) (i32.const 15))))
    (if (i32.eqz (i32.and (call $vreg (i32.const 1)) (i32.const 0x40)))
      (then
        (local.set $x (i32.const 0))
        (block $bkd (loop $bkl
          (br_if $bkd (i32.ge_u (local.get $x) (i32.const 256)))
          (i32.store8 (i32.add (local.get $fbrow) (local.get $x)) (local.get $bd))
          (local.set $x (i32.add (local.get $x) (i32.const 1)))
          (br $bkl)))
        (return)))
    (local.set $hs (call $vreg (i32.const 8)))
    (if (i32.and (i32.and (local.get $r0) (i32.const 0x40)) (i32.lt_u (local.get $y) (i32.const 16)))
      (then (local.set $hs (i32.const 0))))

    (local.set $sy (i32.add (local.get $y) (call $vreg (i32.const 9))))
    (if (i32.ge_u (local.get $sy) (i32.const 224))
      (then (local.set $sy (i32.sub (local.get $sy) (i32.const 224)))))
    (local.set $row (i32.div_u (local.get $sy) (i32.const 8)))
    (local.set $py (i32.and (local.get $sy) (i32.const 7)))
    (local.set $col (i32.const 0))
    (block $bgdone (loop $bg
      (br_if $bgdone (i32.ge_u (local.get $col) (i32.const 32)))
      (if (i32.and (local.get $r0) (i32.const 0x80))
        (then
          (local.set $o (i32.add (i32.mul (local.get $col) (i32.const 8)) (i32.and (local.get $hs) (i32.const 7))))
          (if (i32.ge_u (i32.and (local.get $o) (i32.const 255)) (i32.const 192))
            (then (local.set $row (i32.div_u (local.get $y) (i32.const 8)))
                  (local.set $py (i32.and (local.get $y) (i32.const 7))))
            (else (local.set $row (i32.div_u (local.get $sy) (i32.const 8)))
                  (local.set $py (i32.and (local.get $sy) (i32.const 7)))))))
      (local.set $tx (i32.and (i32.sub (local.get $col)
                        (i32.div_u (local.get $hs) (i32.const 8))) (i32.const 31)))
      (local.set $ent (i32.add (i32.add (i32.const ${VRAM}) (local.get $ntbase))
        (i32.mul (i32.add (i32.mul (local.get $row) (i32.const 32)) (local.get $tx)) (i32.const 2))))
      (local.set $tile (i32.load8_u (local.get $ent)))
      (local.set $attr (i32.load8_u (i32.add (local.get $ent) (i32.const 1))))
      (if (i32.ne (local.get $tile) (i32.const 0))
        (then (local.set $ntnz (i32.add (local.get $ntnz) (i32.const 1)))))
      (local.set $tile (i32.or (local.get $tile)
        (i32.shl (i32.and (local.get $attr) (i32.const 1)) (i32.const 8))))
      (local.set $pal (i32.shl (i32.and (local.get $attr) (i32.const 8)) (i32.const 1)))
      (local.set $ty (local.get $py))
      (if (i32.and (local.get $attr) (i32.const 4))
        (then (local.set $ty (i32.sub (i32.const 7) (local.get $py)))))
      (local.set $px (i32.const 0))
      (block $pdone (loop $pl
        (br_if $pdone (i32.ge_u (local.get $px) (i32.const 8)))
        (local.set $c (call $tile_pixel (local.get $tile)
          (select (i32.sub (i32.const 7) (local.get $px)) (local.get $px)
                  (i32.and (local.get $attr) (i32.const 2)))
          (local.get $ty)))
        (local.set $x (i32.and (i32.add (i32.mul (local.get $col) (i32.const 8))
          (i32.add (local.get $px) (i32.and (local.get $hs) (i32.const 7))))
          (i32.const 255)))
        (i32.store8 (i32.add (local.get $fbrow) (local.get $x))
                    (i32.or (i32.or (local.get $c) (local.get $pal))
                      (select (i32.const 0x80) (i32.const 0)
                        (i32.and (i32.ne (local.get $c) (i32.const 0))
                                 (i32.ne (i32.and (local.get $attr) (i32.const 0x10)) (i32.const 0))))))
        (if (local.get $c)
          (then (local.set $bgnz (i32.add (local.get $bgnz) (i32.const 1)))))
        (local.set $px (i32.add (local.get $px) (i32.const 1)))
        (br $pl)))
      (local.set $col (i32.add (local.get $col) (i32.const 1)))
      (br $bg)))
    (i32.store8  (i32.add (local.get $lp) (i32.const 4)) (local.get $row))
    (i32.store8  (i32.add (local.get $lp) (i32.const 5)) (local.get $ntnz))
    (i32.store16 (i32.add (local.get $lp) (i32.const 6)) (local.get $bgnz))

    (local.set $satb (i32.shl (i32.and (call $vreg (i32.const 5)) (i32.const 0x7E)) (i32.const 7)))
    (local.set $h16 (i32.and (call $vreg (i32.const 1)) (i32.const 2)))
    (local.set $i (i32.const 0))
    (local.set $drawn (i32.const 0))
    (block $spdone (loop $sp
      (br_if $spdone (i32.ge_u (local.get $i) (i32.const 64)))
      (br_if $spdone (i32.ge_u (local.get $drawn) (i32.const 8)))
      (local.set $syy (i32.load8_u (i32.add (i32.add (i32.const ${VRAM}) (local.get $satb)) (local.get $i))))
      (br_if $spdone (i32.eq (local.get $syy) (i32.const 208)))
      (local.set $syy (i32.and (i32.add (local.get $syy) (i32.const 1)) (i32.const 0xFF)))
      (if (i32.and (i32.ge_s (local.get $y) (local.get $syy))
                   (i32.lt_s (local.get $y) (i32.add (local.get $syy)
                     (select (i32.const 16) (i32.const 8) (local.get $h16)))))
        (then
          (local.set $sxx (i32.load8_u (i32.add (i32.add (i32.const ${VRAM})
            (i32.add (local.get $satb) (i32.const 128))) (i32.mul (local.get $i) (i32.const 2)))))
          (local.set $stile (i32.load8_u (i32.add (i32.add (i32.const ${VRAM})
            (i32.add (local.get $satb) (i32.const 129))) (i32.mul (local.get $i) (i32.const 2)))))
          (if (i32.and (call $vreg (i32.const 6)) (i32.const 4))
            (then (local.set $stile (i32.add (local.get $stile) (i32.const 256)))))
          (local.set $py (i32.sub (local.get $y) (local.get $syy)))
          (if (local.get $h16)
            (then
              (local.set $stile (i32.and (local.get $stile) (i32.const 0xFFFFFFFE)))
              (if (i32.ge_u (local.get $py) (i32.const 8))
                (then (local.set $stile (i32.add (local.get $stile) (i32.const 1)))
                      (local.set $py (i32.sub (local.get $py) (i32.const 8)))))))
          (if (i32.and (call $vreg (i32.const 0)) (i32.const 8))
            (then (local.set $sxx (i32.sub (local.get $sxx) (i32.const 8)))))
          (local.set $px (i32.const 0))
          (block $sdone (loop $spx
            (br_if $sdone (i32.ge_u (local.get $px) (i32.const 8)))
            (local.set $x (i32.add (local.get $sxx) (local.get $px)))
            (if (i32.and (i32.ge_s (local.get $x) (i32.const 0)) (i32.lt_s (local.get $x) (i32.const 256)))
              (then
                (local.set $c (call $tile_pixel (local.get $stile) (local.get $px) (local.get $py)))
                (local.set $o (i32.load8_u (i32.add (local.get $fbrow) (local.get $x))))
                (if (i32.and (i32.ne (local.get $c) (i32.const 0))
                             (i32.eqz (i32.and (local.get $o) (i32.const 0x40))))
                  (then
                    (if (i32.and (local.get $o) (i32.const 0x80))
                      (then (i32.store8 (i32.add (local.get $fbrow) (local.get $x))
                                        (i32.or (local.get $o) (i32.const 0x40))))
                      (else (i32.store8 (i32.add (local.get $fbrow) (local.get $x))
                                        (i32.or (local.get $c) (i32.const 0x50)))))))))
            (local.set $px (i32.add (local.get $px) (i32.const 1)))
            (br $spx)))
          (local.set $drawn (i32.add (local.get $drawn) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sp)))
    (local.set $x (i32.const 0))
    (block $std (loop $stl
      (br_if $std (i32.ge_u (local.get $x) (i32.const 256)))
      (i32.store8 (i32.add (local.get $fbrow) (local.get $x))
        (select (local.get $bd)
                (i32.and (i32.load8_u (i32.add (local.get $fbrow) (local.get $x))) (i32.const 0x1F))
                (i32.and (i32.ne (i32.and (local.get $r0) (i32.const 0x20)) (i32.const 0))
                         (i32.lt_u (local.get $x) (i32.const 8)))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $stl))))
`;
}

/**
 * SN76489 PSG: three tone channels and the noise LFSR, rendered at 48000 Hz,
 * 800 stereo f32 frames per video frame into the wasmcart ring (cursor at
 * ABI+256, a ring index bounded by the 4096-frame capacity). The divider runs
 * at 3579545/16 Hz with a fractional accumulator; the per-channel gain is
 * calibrated against genesis_plus_gx's output level.
 * @param {number} AUDIO ring address
 * @param {number} ABI ABI block address
 */
export function psgWat(AUDIO, ABI, opts = {}) {
  // 48 kHz: 800 samples a 60 Hz frame (NTSC clock 3579545 / 16 / 48000 =
  // 4.661 PSG steps a sample) or 960 a 50 Hz frame (PAL 3546893: 4.618).
  const SAMPLES = opts.pal ? 960 : 800, STEP = opts.pal ? 4618 : 4661;
  return `
  (global $psg_latch (mut i32) (i32.const 0))

  (global $p_t0 (mut i32) (i32.const 0)) (global $p_t1 (mut i32) (i32.const 0)) (global $p_t2 (mut i32) (i32.const 0))
  (global $p_v0 (mut i32) (i32.const 15)) (global $p_v1 (mut i32) (i32.const 15)) (global $p_v2 (mut i32) (i32.const 15))
  (global $p_c0 (mut i32) (i32.const 0)) (global $p_c1 (mut i32) (i32.const 0)) (global $p_c2 (mut i32) (i32.const 0))
  (global $p_o0 (mut i32) (i32.const 1)) (global $p_o1 (mut i32) (i32.const 1)) (global $p_o2 (mut i32) (i32.const 1))
  (global $nreg (mut i32) (i32.const 0)) (global $nvol (mut i32) (i32.const 15))
  (global $ncnt (mut i32) (i32.const 0)) (global $nlfsr (mut i32) (i32.const 0x8000))
  (global $nout (mut i32) (i32.const 0))
  (global $psg_acc (mut i32) (i32.const 0))

  (func $psg_write (param $v i32)
    (local $b i32) (local $ch i32) (local $typ i32)
    (local.set $b (i32.and (local.get $v) (i32.const 0xFF)))
    (if (i32.and (local.get $b) (i32.const 0x80))
      (then
        (local.set $ch (i32.and (i32.shr_u (local.get $b) (i32.const 5)) (i32.const 3)))
        (local.set $typ (i32.and (i32.shr_u (local.get $b) (i32.const 4)) (i32.const 1)))
        (global.set $psg_latch (i32.or (i32.shl (local.get $ch) (i32.const 1)) (local.get $typ)))
        (call $psg_set (global.get $psg_latch)
                       (i32.and (local.get $b) (i32.const 0x0F))
                       (i32.const 1)))
      (else
        (call $psg_set (global.get $psg_latch)
                       (i32.and (local.get $b) (i32.const 0x3F))
                       (i32.const 0)))))

  (func $psg_set (param $reg i32) (param $val i32) (param $low i32)
    (local $cur i32)
    (block $done
      (if (i32.and (local.get $reg) (i32.const 1))
        (then
          (if (i32.eq (local.get $reg) (i32.const 1)) (then (global.set $p_v0 (local.get $val))))
          (if (i32.eq (local.get $reg) (i32.const 3)) (then (global.set $p_v1 (local.get $val))))
          (if (i32.eq (local.get $reg) (i32.const 5)) (then (global.set $p_v2 (local.get $val))))
          (if (i32.eq (local.get $reg) (i32.const 7)) (then (global.set $nvol (local.get $val))))
          (br $done)))
      (if (i32.eq (local.get $reg) (i32.const 6))
        (then
          (global.set $nreg (i32.and (local.get $val) (i32.const 7)))
          (global.set $nlfsr (i32.const 0x8000))
          (br $done)))
      (if (i32.eq (local.get $reg) (i32.const 0))
        (then (global.set $p_t0 (select
                (i32.or (i32.and (global.get $p_t0) (i32.const 0x3F0)) (local.get $val))
                (i32.or (i32.and (global.get $p_t0) (i32.const 0x00F)) (i32.shl (local.get $val) (i32.const 4)))
                (local.get $low)))))
      (if (i32.eq (local.get $reg) (i32.const 2))
        (then (global.set $p_t1 (select
                (i32.or (i32.and (global.get $p_t1) (i32.const 0x3F0)) (local.get $val))
                (i32.or (i32.and (global.get $p_t1) (i32.const 0x00F)) (i32.shl (local.get $val) (i32.const 4)))
                (local.get $low)))))
      (if (i32.eq (local.get $reg) (i32.const 4))
        (then (global.set $p_t2 (select
                (i32.or (i32.and (global.get $p_t2) (i32.const 0x3F0)) (local.get $val))
                (i32.or (i32.and (global.get $p_t2) (i32.const 0x00F)) (i32.shl (local.get $val) (i32.const 4)))
                (local.get $low)))))))

  (func $psg_vol (param $att i32) (result f32)
    (local $a i32)
    (local.set $a (i32.and (local.get $att) (i32.const 15)))
    (if (i32.eq (local.get $a) (i32.const 0)) (then (return (f32.const 0.062069))))
    (if (i32.eq (local.get $a) (i32.const 1)) (then (return (f32.const 0.049303))))
    (if (i32.eq (local.get $a) (i32.const 2)) (then (return (f32.const 0.039163))))
    (if (i32.eq (local.get $a) (i32.const 3)) (then (return (f32.const 0.031108))))
    (if (i32.eq (local.get $a) (i32.const 4)) (then (return (f32.const 0.024710))))
    (if (i32.eq (local.get $a) (i32.const 5)) (then (return (f32.const 0.019628))))
    (if (i32.eq (local.get $a) (i32.const 6)) (then (return (f32.const 0.015591))))
    (if (i32.eq (local.get $a) (i32.const 7)) (then (return (f32.const 0.012384))))
    (if (i32.eq (local.get $a) (i32.const 8)) (then (return (f32.const 0.009837))))
    (if (i32.eq (local.get $a) (i32.const 9)) (then (return (f32.const 0.007814))))
    (if (i32.eq (local.get $a) (i32.const 10)) (then (return (f32.const 0.006207))))
    (if (i32.eq (local.get $a) (i32.const 11)) (then (return (f32.const 0.004930))))
    (if (i32.eq (local.get $a) (i32.const 12)) (then (return (f32.const 0.003916))))
    (if (i32.eq (local.get $a) (i32.const 13)) (then (return (f32.const 0.003111))))
    (if (i32.eq (local.get $a) (i32.const 14)) (then (return (f32.const 0.002471))))
    (if (i32.eq (local.get $a) (i32.const 15)) (then (return (f32.const 0.000000))))
    (f32.const 0))

  (func $psg_tick (param $steps i32)
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $steps)))
      (global.set $p_c0 (i32.sub (global.get $p_c0) (i32.const 1)))
      (if (i32.le_s (global.get $p_c0) (i32.const 0))
        (then (global.set $p_c0 (select (global.get $p_t0) (i32.const 1)
                                 (i32.gt_u (global.get $p_t0) (i32.const 0))))
              (global.set $p_o0 (i32.xor (global.get $p_o0) (i32.const 1)))))
      (global.set $p_c1 (i32.sub (global.get $p_c1) (i32.const 1)))
      (if (i32.le_s (global.get $p_c1) (i32.const 0))
        (then (global.set $p_c1 (select (global.get $p_t1) (i32.const 1)
                                 (i32.gt_u (global.get $p_t1) (i32.const 0))))
              (global.set $p_o1 (i32.xor (global.get $p_o1) (i32.const 1)))))
      (global.set $p_c2 (i32.sub (global.get $p_c2) (i32.const 1)))
      (if (i32.le_s (global.get $p_c2) (i32.const 0))
        (then (global.set $p_c2 (select (global.get $p_t2) (i32.const 1)
                                 (i32.gt_u (global.get $p_t2) (i32.const 0))))
              (global.set $p_o2 (i32.xor (global.get $p_o2) (i32.const 1)))))
      (global.set $ncnt (i32.sub (global.get $ncnt) (i32.const 1)))
      (if (i32.le_s (global.get $ncnt) (i32.const 0))
        (then
          (global.set $ncnt
            (select (global.get $p_t2)
                    (i32.shl (i32.const 0x10) (i32.and (global.get $nreg) (i32.const 3)))
                    (i32.eq (i32.and (global.get $nreg) (i32.const 3)) (i32.const 3))))
          (if (i32.eqz (global.get $ncnt)) (then (global.set $ncnt (i32.const 1))))
          (global.set $nout (i32.and (global.get $nlfsr) (i32.const 1)))
          (global.set $nlfsr
            (i32.or (i32.shr_u (global.get $nlfsr) (i32.const 1))
              (i32.shl
                (select
                  (i32.and (i32.xor (global.get $nlfsr)
                                    (i32.shr_u (global.get $nlfsr) (i32.const 3)))
                           (i32.const 1))
                  (i32.and (global.get $nlfsr) (i32.const 1))
                  (i32.and (global.get $nreg) (i32.const 4)))
                (i32.const 15))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $psg_render
    (local $i i32) (local $cur i32) (local $addr i32) (local $s f32)
    (local.set $cur (i32.load (i32.add (i32.const ${ABI}) (i32.const 256))))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const ${SAMPLES})))
      (global.set $psg_acc (i32.add (global.get $psg_acc) (i32.const ${STEP})))
      (call $psg_tick (i32.div_u (global.get $psg_acc) (i32.const 1000)))
      (global.set $psg_acc (i32.rem_u (global.get $psg_acc) (i32.const 1000)))
      (local.set $s (f32.add
        (f32.add
          (f32.mul (f32.convert_i32_s (i32.sub (i32.shl (global.get $p_o0) (i32.const 1)) (i32.const 1)))
                   (call $psg_vol (global.get $p_v0)))
          (f32.mul (f32.convert_i32_s (i32.sub (i32.shl (global.get $p_o1) (i32.const 1)) (i32.const 1)))
                   (call $psg_vol (global.get $p_v1))))
        (f32.add
          (f32.mul (f32.convert_i32_s (i32.sub (i32.shl (global.get $p_o2) (i32.const 1)) (i32.const 1)))
                   (call $psg_vol (global.get $p_v2)))
          (f32.mul (f32.convert_i32_s (i32.sub (i32.shl (global.get $nout) (i32.const 1)) (i32.const 1)))
                   (call $psg_vol (global.get $nvol))))))
      (local.set $addr (i32.add (i32.const ${AUDIO})
        (i32.mul (i32.and (local.get $cur) (i32.const 4095)) (i32.const 8))))
      (f32.store (local.get $addr) (local.get $s))
      (f32.store offset=4 (local.get $addr) (local.get $s))
      (local.set $cur (i32.and (i32.add (local.get $cur) (i32.const 1))
                               (i32.const 4095)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 256)) (local.get $cur)))
`;
}

/**
 * Z80 ops that are simpler as calls: ex af / exx, daa, adc/sbc hl (full
 * flags: S from bit 15, H from bit 11, PV signed overflow - the signed
 * 16-bit compare idiom `sbc hl,de` + `jp m` depends on S), CB shifts and
 * rotates (sll/sli sets bit 0), ldi/ldd/cpi/cpd steps, outi/outd with the
 * exact OUTI flag rules, rld/rrd.
 */
export function miscWat(opts = {}) {
  const text = miscLegacyWat();
  if (!opts.exact) return text;
  // The earlier emitter implemented INI/IND as OUTI/OUTD (writing memory to the port
  // instead of reading the port into memory). These follow gpgx's INI/IND
  // macros: read port BC, B-1, store at HL, HL+-1, flags from B and
  // ((C+-1) & $FF) + value.
  const fixed = text
    .replace("  (func $ini (call $outi_step))", "  (func $ini (call $ini_step (i32.const 1)))")
    .replace("  (func $inir (call $otir))", `  (func $inir (block $d (loop $l (call $ini_step (i32.const 1))
    (br_if $d (i32.eqz (global.get $b))) (br $l))))`)
    .replace("  (func $ind (call $outd_step))", "  (func $ind (call $ini_step (i32.const -1)))")
    .replace("  (func $indr (call $otdr))", `  (func $indr (block $d (loop $l (call $ini_step (i32.const -1))
    (br_if $d (i32.eqz (global.get $b))) (br $l))))`);
  if (fixed === text) throw new Error("sms recompile: INI/IND helpers not found in the misc text");
  // Undocumented flags (F bits 5 and 3) and DAA's P/V, as gpgx computes them:
  // they reach RAM through push af, so the machine state is only exact with them.
  let exact = replaceFunc(fixed, "daa", `  (func $daa
    (local $a i32) (local $f i32)
    (local.set $a (global.get $a))
    (local.set $f (global.get $f))
    (if (i32.and (local.get $f) (i32.const 2))
      (then
        (if (i32.or (i32.and (local.get $f) (i32.const 0x10)) (i32.gt_u (i32.and (global.get $a) (i32.const 0xF)) (i32.const 9)))
          (then (local.set $a (i32.sub (local.get $a) (i32.const 6)))))
        (if (i32.or (i32.and (local.get $f) (i32.const 1)) (i32.gt_u (global.get $a) (i32.const 0x99)))
          (then (local.set $a (i32.sub (local.get $a) (i32.const 0x60))))))
      (else
        (if (i32.or (i32.and (local.get $f) (i32.const 0x10)) (i32.gt_u (i32.and (global.get $a) (i32.const 0xF)) (i32.const 9)))
          (then (local.set $a (i32.add (local.get $a) (i32.const 6)))))
        (if (i32.or (i32.and (local.get $f) (i32.const 1)) (i32.gt_u (global.get $a) (i32.const 0x99)))
          (then (local.set $a (i32.add (local.get $a) (i32.const 0x60)))))))
    (local.set $a (i32.and (local.get $a) (i32.const 0xFF)))
    (global.set $f (i32.or (i32.or (i32.and (local.get $f) (i32.const 3))
                                   (i32.gt_u (global.get $a) (i32.const 0x99)))
                           (i32.or (i32.and (i32.xor (global.get $a) (local.get $a)) (i32.const 0x10))
                                   (call $szp (local.get $a)))))
    (global.set $a (local.get $a)))
`);
  for (const name of ["sbc16", "adc16"]) {
    const body = funcText(exact, name);
    const patched = body.replace("(i32.and (i32.shr_u (local.get $r) (i32.const 8)) (i32.const 0x80))",
      "(i32.and (i32.shr_u (local.get $r) (i32.const 8)) (i32.const 0xA8))");
    if (patched === body) throw new Error(`sms recompile: could not patch $${name}`);
    exact = exact.replace(body, patched);
  }
  {
    const body = funcText(exact, "ldi_step");
    const patched = body
      .replace("(local $hl i32) (local $de i32) (local $bc i32)", "(local $hl i32) (local $de i32) (local $bc i32) (local $io i32) (local $n i32)")
      .replace("(call $wr8 (local.get $de) (call $rd8 (local.get $hl)))", "(local.set $io (call $rd8 (local.get $hl))) (call $wr8 (local.get $de) (local.get $io))")
      .replace(`    (global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xC1))
                           (select (i32.const 4) (i32.const 0) (local.get $bc)))))`, `    (local.set $n (i32.add (global.get $a) (local.get $io)))
    (global.set $f (i32.or (i32.or (i32.and (global.get $f) (i32.const 0xC1))
                                   (select (i32.const 4) (i32.const 0) (local.get $bc)))
                           (i32.or (i32.shl (i32.and (local.get $n) (i32.const 2)) (i32.const 4))
                                   (i32.and (local.get $n) (i32.const 8))))))`);
    if (patched === body || !patched.includes("local.set $n")) throw new Error("sms recompile: could not patch $ldi_step");
    exact = exact.replace(body, patched);
  }
  {
    const body = funcText(exact, "cpi_step");
    const patched = body.replace(`    (if (local.get $bc)
      (then (local.set $f (i32.or (local.get $f) (i32.const 4)))))
    (global.set $f (local.get $f)))`, `    (if (local.get $bc)
      (then (local.set $f (i32.or (local.get $f) (i32.const 4)))))
    (global.set $wz (i32.and (i32.add (global.get $wz) (local.get $dir)) (i32.const 0xFFFF)))
    (if (i32.and (local.get $f) (i32.const 0x10))
      (then (local.set $r (i32.and (i32.sub (local.get $r) (i32.const 1)) (i32.const 0xFF)))))
    (local.set $f (i32.or (local.get $f)
      (i32.or (i32.shl (i32.and (local.get $r) (i32.const 2)) (i32.const 4)) (i32.and (local.get $r) (i32.const 8)))))
    (global.set $f (local.get $f)))`);
    if (patched === body) throw new Error("sms recompile: could not patch $cpi_step");
    exact = exact.replace(body, patched);
  }
  // OUTI/OUTD: WZ = BC +- 1 after B is decremented (gpgx OUTI/OUTD)
  for (const [fn, d] of [["outi_step", 1], ["outd_step", -1]]) {
    const body = funcText(exact, fn);
    const dec = "    (global.set $b (i32.and (i32.sub (global.get $b) (i32.const 1)) (i32.const 0xFF)))\n";
    if (!body.includes(dec)) throw new Error(`sms recompile: could not patch $${fn}`);
    exact = exact.replace(body, body.replace(dec, dec + `    (global.set $wz (i32.and (i32.add (i32.or (i32.shl (global.get $b) (i32.const 8)) (global.get $c)) (i32.const ${d})) (i32.const 0xFFFF)))\n`));
  }
  return exact + `
  (func $ini_step (param $dir i32)
    (local $hl i32) (local $io i32) (local $t i32) (local $f i32)
    (local.set $io (call $io_read (global.get $c)))
    (global.set $wz (i32.and (i32.add (i32.or (i32.shl (global.get $b) (i32.const 8)) (global.get $c)) (local.get $dir)) (i32.const 0xFFFF)))
    (global.set $b (i32.and (i32.sub (global.get $b) (i32.const 1)) (i32.const 0xFF)))
    (local.set $hl (i32.or (i32.shl (global.get $h) (i32.const 8)) (global.get $l)))
    (call $wr8 (local.get $hl) (local.get $io))
    (local.set $hl (i32.and (i32.add (local.get $hl) (local.get $dir)) (i32.const 0xFFFF)))
    (global.set $h (i32.shr_u (local.get $hl) (i32.const 8)))
    (global.set $l (i32.and (local.get $hl) (i32.const 0xFF)))
    (local.set $f (i32.and (call $szp (global.get $b)) (i32.const 0xA8)))
    (if (i32.eqz (global.get $b)) (then (local.set $f (i32.or (local.get $f) (i32.const 0x40)))))
    (local.set $t (i32.add (i32.and (i32.add (global.get $c) (local.get $dir)) (i32.const 0xFF)) (local.get $io)))
    (if (i32.and (local.get $io) (i32.const 0x80)) (then (local.set $f (i32.or (local.get $f) (i32.const 0x02)))))
    (if (i32.and (local.get $t) (i32.const 0x100)) (then (local.set $f (i32.or (local.get $f) (i32.const 0x11)))))
    (local.set $f (i32.or (local.get $f)
      (i32.and (call $szp (i32.xor (i32.and (local.get $t) (i32.const 0x07)) (global.get $b))) (i32.const 0x04))))
    (global.set $f (local.get $f)))
`;
}

/** The text of `(func $name ...)` in a module fragment, up to the next top-level func. */
function funcText(text, name) {
  const start = text.indexOf(`  (func $${name} `) >= 0 ? text.indexOf(`  (func $${name} `) : text.indexOf(`  (func $${name}\n`);
  if (start < 0) throw new Error(`sms recompile: helper $${name} not found`);
  const next = text.indexOf("\n  (func ", start + 5);
  return text.slice(start, next < 0 ? text.length : next + 1);
}

function replaceFunc(text, name, replacement) {
  const body = funcText(text, name);
  return text.replace(body, replacement.endsWith("\n") ? replacement : replacement + "\n");
}

function miscLegacyWat() {
  return `
  (func $ex_af
    (local $t i32)
    (local.set $t (global.get $a)) (global.set $a (global.get $a2)) (global.set $a2 (local.get $t))
    (local.set $t (global.get $f)) (global.set $f (global.get $f2)) (global.set $f2 (local.get $t)))

  (func $exx
    (local $t i32)
    (local.set $t (global.get $b)) (global.set $b (global.get $b2)) (global.set $b2 (local.get $t))
    (local.set $t (global.get $c)) (global.set $c (global.get $c2)) (global.set $c2 (local.get $t))
    (local.set $t (global.get $d)) (global.set $d (global.get $d2)) (global.set $d2 (local.get $t))
    (local.set $t (global.get $e)) (global.set $e (global.get $e2)) (global.set $e2 (local.get $t))
    (local.set $t (global.get $h)) (global.set $h (global.get $h2)) (global.set $h2 (local.get $t))
    (local.set $t (global.get $l)) (global.set $l (global.get $l2)) (global.set $l2 (local.get $t)))

  (func $daa
    (local $c i32) (local $add i32) (local $r i32)
    (local.set $c (i32.and (global.get $f) (i32.const 1)))
    (if (i32.or (i32.and (global.get $f) (i32.const 0x10))
                (i32.gt_u (i32.and (global.get $a) (i32.const 0xF)) (i32.const 9)))
      (then (local.set $add (i32.const 6))))
    (if (i32.or (local.get $c) (i32.gt_u (global.get $a) (i32.const 0x99)))
      (then (local.set $add (i32.or (local.get $add) (i32.const 0x60)))
            (local.set $c (i32.const 1))))
    (if (i32.and (global.get $f) (i32.const 2))
      (then (local.set $r (call $sub8 (global.get $a) (local.get $add) (i32.const 0))))
      (else (local.set $r (call $add8 (global.get $a) (local.get $add) (i32.const 0)))))
    (global.set $a (local.get $r))
    (global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xFE)) (local.get $c))))

  (func $sbc16 (param $x i32) (param $y i32) (result i32)
    (local $r i32) (local $c i32)
    (local.set $c (i32.and (global.get $f) (i32.const 1)))
    (local.set $r (i32.sub (i32.sub (local.get $x) (local.get $y)) (local.get $c)))
    (global.set $f (i32.or (i32.or (i32.or
      (i32.const 2)
      (i32.and (i32.shr_u (local.get $r) (i32.const 16)) (i32.const 1)))
      (i32.or
        (select (i32.const 0x40) (i32.const 0) (i32.eqz (i32.and (local.get $r) (i32.const 0xFFFF))))
        (i32.and (i32.shr_u (local.get $r) (i32.const 8)) (i32.const 0x80))))
      (i32.or
        (i32.shl (i32.and (i32.shr_u
          (i32.sub (i32.sub (i32.and (local.get $x) (i32.const 0xFFF))
                            (i32.and (local.get $y) (i32.const 0xFFF)))
                   (local.get $c))
          (i32.const 12)) (i32.const 1)) (i32.const 4))
        (i32.shr_u (i32.and
          (i32.and (i32.xor (local.get $x) (local.get $y))
                   (i32.xor (local.get $x) (local.get $r)))
          (i32.const 0x8000)) (i32.const 13)))))
    (i32.and (local.get $r) (i32.const 0xFFFF)))

  (func $adc16 (param $x i32) (param $y i32) (result i32)
    (local $r i32) (local $c i32)
    (local.set $c (i32.and (global.get $f) (i32.const 1)))
    (local.set $r (i32.add (i32.add (local.get $x) (local.get $y)) (local.get $c)))
    (global.set $f (i32.or (i32.or
      (i32.and (i32.shr_u (local.get $r) (i32.const 16)) (i32.const 1))
      (i32.or
        (select (i32.const 0x40) (i32.const 0) (i32.eqz (i32.and (local.get $r) (i32.const 0xFFFF))))
        (i32.and (i32.shr_u (local.get $r) (i32.const 8)) (i32.const 0x80))))
      (i32.or
        (i32.shl (i32.and (i32.shr_u
          (i32.add (i32.add (i32.and (local.get $x) (i32.const 0xFFF))
                            (i32.and (local.get $y) (i32.const 0xFFF)))
                   (local.get $c))
          (i32.const 12)) (i32.const 1)) (i32.const 4))
        (i32.shr_u (i32.and
          (i32.and (i32.xor (local.get $x) (i32.xor (local.get $y) (i32.const 0xFFFF)))
                   (i32.xor (local.get $x) (local.get $r)))
          (i32.const 0x8000)) (i32.const 13)))))
    (i32.and (local.get $r) (i32.const 0xFFFF)))

  (func $rl (param $v i32) (result i32)
    (local $r i32)
    (local.set $r (i32.or (i32.shl (local.get $v) (i32.const 1)) (i32.and (global.get $f) (i32.const 1))))
    (global.set $f (i32.or (call $szp (i32.and (local.get $r) (i32.const 0xFF)))
                           (i32.shr_u (local.get $v) (i32.const 7))))
    (i32.and (local.get $r) (i32.const 0xFF)))
  (func $rr (param $v i32) (result i32)
    (local $r i32)
    (local.set $r (i32.or (i32.shr_u (local.get $v) (i32.const 1))
                          (i32.shl (i32.and (global.get $f) (i32.const 1)) (i32.const 7))))
    (global.set $f (i32.or (call $szp (local.get $r)) (i32.and (local.get $v) (i32.const 1))))
    (local.get $r))
  (func $rlc (param $v i32) (result i32)
    (local $r i32)
    (local.set $r (i32.and (i32.or (i32.shl (local.get $v) (i32.const 1))
                                   (i32.shr_u (local.get $v) (i32.const 7))) (i32.const 0xFF)))
    (global.set $f (i32.or (call $szp (local.get $r)) (i32.shr_u (local.get $v) (i32.const 7))))
    (local.get $r))
  (func $rrc (param $v i32) (result i32)
    (local $r i32)
    (local.set $r (i32.and (i32.or (i32.shr_u (local.get $v) (i32.const 1))
                                   (i32.shl (local.get $v) (i32.const 7))) (i32.const 0xFF)))
    (global.set $f (i32.or (call $szp (local.get $r)) (i32.and (local.get $v) (i32.const 1))))
    (local.get $r))
  (func $sla (param $v i32) (result i32)
    (local $r i32)
    (local.set $r (i32.and (i32.shl (local.get $v) (i32.const 1)) (i32.const 0xFF)))
    (global.set $f (i32.or (call $szp (local.get $r)) (i32.shr_u (local.get $v) (i32.const 7))))
    (local.get $r))
  (func $sra (param $v i32) (result i32)
    (local $r i32)
    (local.set $r (i32.or (i32.shr_u (local.get $v) (i32.const 1))
                          (i32.and (local.get $v) (i32.const 0x80))))
    (global.set $f (i32.or (call $szp (local.get $r)) (i32.and (local.get $v) (i32.const 1))))
    (local.get $r))
  (func $srl (param $v i32) (result i32)
    (local $r i32)
    (local.set $r (i32.shr_u (local.get $v) (i32.const 1)))
    (global.set $f (i32.or (call $szp (local.get $r)) (i32.and (local.get $v) (i32.const 1))))
    (local.get $r))
  (func $sll (param $v i32) (result i32)
    (local $r i32)
    (local.set $r (i32.and (i32.or (i32.shl (local.get $v) (i32.const 1))
                                   (i32.const 1)) (i32.const 0xFF)))
    (global.set $f (i32.or (call $szp (local.get $r))
                           (i32.shr_u (i32.and (local.get $v) (i32.const 0x80)) (i32.const 7))))
    (local.get $r))

  (func $ldi_step (param $dir i32)
    (local $hl i32) (local $de i32) (local $bc i32)
    (local.set $hl (i32.or (i32.shl (global.get $h) (i32.const 8)) (global.get $l)))
    (local.set $de (i32.or (i32.shl (global.get $d) (i32.const 8)) (global.get $e)))
    (local.set $bc (i32.or (i32.shl (global.get $b) (i32.const 8)) (global.get $c)))
    (call $wr8 (local.get $de) (call $rd8 (local.get $hl)))
    (local.set $hl (i32.and (i32.add (local.get $hl) (local.get $dir)) (i32.const 0xFFFF)))
    (local.set $de (i32.and (i32.add (local.get $de) (local.get $dir)) (i32.const 0xFFFF)))
    (local.set $bc (i32.and (i32.sub (local.get $bc) (i32.const 1)) (i32.const 0xFFFF)))
    (global.set $h (i32.shr_u (local.get $hl) (i32.const 8))) (global.set $l (i32.and (local.get $hl) (i32.const 0xFF)))
    (global.set $d (i32.shr_u (local.get $de) (i32.const 8))) (global.set $e (i32.and (local.get $de) (i32.const 0xFF)))
    (global.set $b (i32.shr_u (local.get $bc) (i32.const 8))) (global.set $c (i32.and (local.get $bc) (i32.const 0xFF)))
    (global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xC1))
                           (select (i32.const 4) (i32.const 0) (local.get $bc)))))

  (func $ldi (call $ldi_step (i32.const 1)))
  (func $ldd (call $ldi_step (i32.const -1)))
  (func $ldir (block $d (loop $l (call $ldi_step (i32.const 1))
    (br_if $d (i32.eqz (i32.or (global.get $b) (global.get $c)))) (br $l))))
  (func $lddr (block $d (loop $l (call $ldi_step (i32.const -1))
    (br_if $d (i32.eqz (i32.or (global.get $b) (global.get $c)))) (br $l))))

  (func $outi_step
    (local $hl i32) (local $io i32)
    (local.set $hl (i32.or (i32.shl (global.get $h) (i32.const 8)) (global.get $l)))
    (local.set $io (call $rd8 (local.get $hl)))
    (call $io_write (global.get $c) (local.get $io))
    (local.set $hl (i32.and (i32.add (local.get $hl) (i32.const 1)) (i32.const 0xFFFF)))
    (global.set $h (i32.shr_u (local.get $hl) (i32.const 8)))
    (global.set $l (i32.and (local.get $hl) (i32.const 0xFF)))
    (global.set $b (i32.and (i32.sub (global.get $b) (i32.const 1)) (i32.const 0xFF)))
    (call $blockio_flags (local.get $io)))

  (func $blockio_flags (param $io i32)
    (local $t i32) (local $f i32)
    (local.set $f (call $szp (global.get $b)))
    (local.set $f (i32.and (local.get $f) (i32.const 0xA8)))
    (if (i32.eqz (global.get $b))
      (then (local.set $f (i32.or (local.get $f) (i32.const 0x40)))))
    (local.set $t (i32.add (global.get $l) (local.get $io)))
    (if (i32.and (local.get $io) (i32.const 0x80))
      (then (local.set $f (i32.or (local.get $f) (i32.const 0x02)))))
    (if (i32.and (local.get $t) (i32.const 0x100))
      (then (local.set $f (i32.or (local.get $f) (i32.const 0x11)))))
    (local.set $f (i32.or (local.get $f)
      (i32.and (call $szp (i32.xor (i32.and (local.get $t) (i32.const 0x07))
                                   (global.get $b)))
               (i32.const 0x04))))
    (global.set $f (local.get $f)))
  (func $outi (call $outi_step))
  (func $otir (block $d (loop $l (call $outi_step)
    (br_if $d (i32.eqz (global.get $b))) (br $l))))
  (func $ini (call $outi_step))
  (func $inir (call $otir))

  (func $outd_step
    (local $hl i32) (local $io i32)
    (local.set $hl (i32.or (i32.shl (global.get $h) (i32.const 8)) (global.get $l)))
    (local.set $io (call $rd8 (local.get $hl)))
    (call $io_write (global.get $c) (local.get $io))
    (local.set $hl (i32.and (i32.sub (local.get $hl) (i32.const 1)) (i32.const 0xFFFF)))
    (global.set $h (i32.shr_u (local.get $hl) (i32.const 8)))
    (global.set $l (i32.and (local.get $hl) (i32.const 0xFF)))
    (global.set $b (i32.and (i32.sub (global.get $b) (i32.const 1)) (i32.const 0xFF)))
    (call $blockio_flags (local.get $io)))
  (func $outd (call $outd_step))
  (func $otdr (block $d (loop $l (call $outd_step)
    (br_if $d (i32.eqz (global.get $b))) (br $l))))
  (func $ind (call $outd_step))
  (func $indr (call $otdr))

  (func $rld
    (local $hl i32) (local $m i32) (local $a i32)
    (local.set $hl (i32.or (i32.shl (global.get $h) (i32.const 8)) (global.get $l)))
    (local.set $m (call $rd8 (local.get $hl)))
    (local.set $a (global.get $a))
    (call $wr8 (local.get $hl)
      (i32.and (i32.or (i32.shl (local.get $m) (i32.const 4))
                       (i32.and (local.get $a) (i32.const 0x0F)))
               (i32.const 0xFF)))
    (global.set $a (i32.or (i32.and (local.get $a) (i32.const 0xF0))
                           (i32.shr_u (local.get $m) (i32.const 4))))
    (global.set $f (i32.or (i32.and (global.get $f) (i32.const 0x01))
                           (i32.and (call $szp (global.get $a)) (i32.const 0xFC)))))

  (func $rrd
    (local $hl i32) (local $m i32) (local $a i32)
    (local.set $hl (i32.or (i32.shl (global.get $h) (i32.const 8)) (global.get $l)))
    (local.set $m (call $rd8 (local.get $hl)))
    (local.set $a (global.get $a))
    (call $wr8 (local.get $hl)
      (i32.and (i32.or (i32.shl (i32.and (local.get $a) (i32.const 0x0F)) (i32.const 4))
                       (i32.shr_u (local.get $m) (i32.const 4)))
               (i32.const 0xFF)))
    (global.set $a (i32.or (i32.and (local.get $a) (i32.const 0xF0))
                           (i32.and (local.get $m) (i32.const 0x0F))))
    (global.set $f (i32.or (i32.and (global.get $f) (i32.const 0x01))
                           (i32.and (call $szp (global.get $a)) (i32.const 0xFC)))))
  (func $cpi_step (param $dir i32)
    (local $hl i32) (local $bc i32) (local $v i32) (local $r i32) (local $f i32)
    (local.set $hl (i32.or (i32.shl (global.get $h) (i32.const 8)) (global.get $l)))
    (local.set $bc (i32.or (i32.shl (global.get $b) (i32.const 8)) (global.get $c)))
    (local.set $v (call $rd8 (local.get $hl)))
    (local.set $r (i32.and (i32.sub (global.get $a) (local.get $v)) (i32.const 0xFF)))
    (local.set $hl (i32.and (i32.add (local.get $hl) (local.get $dir)) (i32.const 0xFFFF)))
    (local.set $bc (i32.and (i32.sub (local.get $bc) (i32.const 1)) (i32.const 0xFFFF)))
    (global.set $h (i32.shr_u (local.get $hl) (i32.const 8)))
    (global.set $l (i32.and (local.get $hl) (i32.const 0xFF)))
    (global.set $b (i32.shr_u (local.get $bc) (i32.const 8)))
    (global.set $c (i32.and (local.get $bc) (i32.const 0xFF)))
    (local.set $f (i32.or (i32.and (global.get $f) (i32.const 1)) (i32.const 2)))
    (if (i32.eqz (local.get $r))
      (then (local.set $f (i32.or (local.get $f) (i32.const 0x40)))))
    (local.set $f (i32.or (local.get $f) (i32.and (local.get $r) (i32.const 0x80))))
    (if (i32.lt_u (i32.and (global.get $a) (i32.const 0x0F))
                  (i32.and (local.get $v) (i32.const 0x0F)))
      (then (local.set $f (i32.or (local.get $f) (i32.const 0x10)))))
    (if (local.get $bc)
      (then (local.set $f (i32.or (local.get $f) (i32.const 4)))))
    (global.set $f (local.get $f)))
  (func $cpi (call $cpi_step (i32.const 1)))
  (func $cpd (call $cpi_step (i32.const -1)))
  (func $cpir (block $d (loop $l (call $cpi_step (i32.const 1))
    (br_if $d (i32.eqz (i32.and (global.get $f) (i32.const 4))))
    (br_if $d (i32.and (global.get $f) (i32.const 0x40))) (br $l))))
  (func $cpdr (block $d (loop $l (call $cpi_step (i32.const -1))
    (br_if $d (i32.eqz (i32.and (global.get $f) (i32.const 4))))
    (br_if $d (i32.and (global.get $f) (i32.const 0x40))) (br $l))))

`;
}

/**
 * CRAM entry -> r/g/b locals for $cram_rgba. SMS: 1 byte --BBGGRR, 2 bits
 * per channel, looked up at n*5. GG: 2 bytes little-endian 0x0BGR, 4 bits
 * per channel.
 * @param {'sms'|'gg'} platform
 * @param {number} base CRAM address
 */
export function cramBody(platform, base) {
  if (platform === "gg") return `    (local.set $c (i32.load16_u (i32.add (i32.const ${base}) (i32.mul (i32.and (local.get $i) (i32.const 0x1F)) (i32.const 2)))))
    (local.set $r (i32.load8_u (i32.add (i32.const ${GGLUT}) (i32.and (local.get $c) (i32.const 0xF)))))
    (local.set $g (i32.load8_u (i32.add (i32.const ${GGLUT}) (i32.add (i32.const 16) (i32.and (i32.shr_u (local.get $c) (i32.const 4)) (i32.const 0xF))))))
    (local.set $b (i32.load8_u (i32.add (i32.const ${GGLUT}) (i32.add (i32.const 32) (i32.and (i32.shr_u (local.get $c) (i32.const 8)) (i32.const 0xF))))))`;
  return `    (local.set $c (if (result i32) (i32.and (local.get $i) (i32.const 0x20))
      (then (i32.load8_u (i32.add (i32.const ${TMSCROM}) (i32.and (local.get $i) (i32.const 15)))))
      (else (i32.load8_u (i32.add (i32.const ${base}) (i32.and (local.get $i) (i32.const 0x1F)))))))
    (local.set $r (i32.load8_u (i32.add (i32.const ${GGLUT}) (i32.mul (i32.and (local.get $c) (i32.const 3)) (i32.const 5)))))
    (local.set $g (i32.load8_u (i32.add (i32.const ${GGLUT}) (i32.add (i32.const 16) (i32.mul (i32.and (i32.shr_u (local.get $c) (i32.const 2)) (i32.const 3)) (i32.const 5))))))
    (local.set $b (i32.load8_u (i32.add (i32.const ${GGLUT}) (i32.add (i32.const 32) (i32.mul (i32.and (i32.shr_u (local.get $c) (i32.const 4)) (i32.const 3)) (i32.const 5))))))`;
}

/**
 * START handling in wc_render. The GG has a real START on port $00 bit 7,
 * active low. The Master System's is the PAUSE button: exact mode takes it
 * as an NMI (pauseNmiWat), as genesis_plus_gx does; the legacy model
 * aliased it to button 1.
 * @param {'sms'|'gg'} platform
 * @param {boolean} [exact]
 */
export function startBody(platform, exact = false) {
  if (platform === "gg") return `    (global.set $ggstart (i32.const 0x80))
    (if (i32.and (local.get $btn) (i32.const 64))
      (then (global.set $ggstart (i32.const 0))))`;
  if (exact) return "";
  return `    (if (i32.and (local.get $btn) (i32.const 64))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xEF)))))`;
}

/**
 * The Master System PAUSE button (wasmcart START, bit 64), as
 * genesis_plus_gx's system_frame_sms raises it: checked once a frame, at the
 * start of the last line (after the line counter reload, before that line
 * runs), edge-triggered, and taken on the spot: IFF1 cleared (IFF2 kept for
 * RETN), PC pushed, PC = $0066, 11 T. The Game Gear has no NMI.
 * @param {'sms'|'gg'} platform
 */
export function pauseNmiWat(platform) {
  if (platform === "gg") return "";
  return `          (if (i32.and (local.get $btn) (i32.const 64))
            (then (if (i32.eqz (global.get $pauseb))
              (then (global.set $pauseb (i32.const 1))
                    (global.set $halted (i32.const 0))
                    (global.set $iff (i32.const 0))
                    (call $push16 (global.get $pc))
                    (global.set $pc (i32.const 0x66))
                    (global.set $wz (i32.const 0x66))
                    (global.set $carry (i32.sub (global.get $carry) (i32.const 11))))))
            (else (global.set $pauseb (i32.const 0))))
`;
}
