// Genesis (genesis-plus-gx) live state decoders.
//
// Unlike the SNES decoders which parse savestate blobs, the Genesis
// patch exposes live struct memory directly via retro_get_memory_data.
// So our decoders read directly from the WASM heap at known offsets.
// Fragile against struct layout changes in upstream gpgx - if a test
// breaks loudly after a gpgx update, re-check the offsets here against
// build/gpgx/src/core/m68k/m68k.h.

// Pass-through helper so future per-platform decoders share one output
// shape. Inlined here to avoid circular imports with cpu-state.js.
const formatCpuState = (s) => s;

// ---- m68k struct offset map (wasm32, gpgx master 2026) ----------------
// Source: build/gpgx/src/core/m68k/m68k.h `m68ki_cpu_core` struct.
// `cpu_memory_map memory_map[256]` is the first field; on wasm32 each
// entry is 5 × 4 = 20 bytes, so memory_map takes 256 × 20 = 5120 bytes.
// After that come the fields we want.
const M68K_BASE = 5120; // start of cpu_idle_t poll
// M68K_POLL / M68K_CYCLES document the struct layout (consumed implicitly by the
// next offset) - keep them named even though nothing reads them directly.
// eslint-disable-next-line no-unused-vars
const M68K_POLL = M68K_BASE + 0;       // 12 bytes
// eslint-disable-next-line no-unused-vars
const M68K_CYCLES = M68K_BASE + 12;    // 12 bytes (cycles + refresh_cycles + cycle_end)
const M68K_DAR = M68K_BASE + 24;       // uint dar[16] - D0..D7 then A0..A7
const M68K_PC = M68K_DAR + 64;         // uint pc
const M68K_PREV_PC = M68K_PC + 4;
const M68K_PREV_DR = M68K_PREV_PC + 4; // uint prev_dr[8] - 32 bytes
const M68K_PREV_AR = M68K_PREV_DR + 32;
const M68K_SP = M68K_PREV_AR + 32;     // uint sp[5] - USP, ISP, MSP, etc.
const M68K_IR = M68K_SP + 20;
const M68K_T1 = M68K_IR + 4;
const M68K_S = M68K_T1 + 4;
const M68K_X = M68K_S + 4;
const M68K_N = M68K_X + 4;
const M68K_NOT_Z = M68K_N + 4;
const M68K_V = M68K_NOT_Z + 4;
const M68K_C = M68K_V + 4;
const M68K_INT_MASK = M68K_C + 4;
const M68K_INT_LEVEL = M68K_INT_MASK + 4;
const M68K_STOPPED = M68K_INT_LEVEL + 4;

/**
 * Decode the live 68K CPU state from gpgx's exposed m68k struct.
 *
 * @param {Uint8Array} bytes the genesis_m68k region
 * @returns {ReturnType<typeof formatCpuState>}
 */
export function decodeGenesisM68k(bytes) {
  const u32 = (off) => bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24);
  const D = [], A = [];
  for (let i = 0; i < 8; i++) D.push(u32(M68K_DAR + i * 4));
  for (let i = 0; i < 8; i++) A.push(u32(M68K_DAR + 32 + i * 4));
  const pc = u32(M68K_PC);
  const s  = !!u32(M68K_S);
  const x  = !!u32(M68K_X);
  const n  = !!u32(M68K_N);
  const notZ = !!u32(M68K_NOT_Z);
  const v  = !!u32(M68K_V);
  const c  = !!u32(M68K_C);
  const t1 = !!u32(M68K_T1);
  const intMask = u32(M68K_INT_MASK) & 0xFF;
  const intLevel = u32(M68K_INT_LEVEL) & 0xFF;
  const stopped = !!u32(M68K_STOPPED);
  // A7 is the active stack pointer for whichever mode (USP/ISP/MSP); the
  // sp[5] array holds the inactive copies. For SR-style status we just
  // surface what's needed and let agents query the SP they care about.
  const sp = A[7];
  return formatCpuState({
    pc,
    registers: {
      D0: D[0], D1: D[1], D2: D[2], D3: D[3], D4: D[4], D5: D[5], D6: D[6], D7: D[7],
      A0: A[0], A1: A[1], A2: A[2], A3: A[3], A4: A[4], A5: A[5], A6: A[6], A7: A[7],
    },
    flags: {
      N: n,
      Z: !notZ,            // gpgx stores NOT_Z for speed; invert for normal-people semantics
      V: v,
      C: c,
      X: x,
      S: s,                // Supervisor
      T: t1,               // Trace
      intMask,             // IPL mask (0..7)
      intLevel,            // current interrupt pins
      stopped,
    },
    sp,
  });
}

// ---- VDP CRAM decoder (palette) ---------------------------------------
//
// Genesis CRAM: 64 entries × 2 bytes, each entry is a 16-bit word but
// only 9 bits encode color (3 bits per channel, in positions 0BBB0GGG0RRR0):
//   bit 0:  unused
//   bits 1-3: R
//   bit 4: unused
//   bits 5-7: G
//   bit 8: unused
//   bits 9-11: B
//   bits 12-15: unused
// Words are stored in big-endian byte order (VDP is m68k-attached).

/**
 * @param {Uint8Array} cram 128 bytes
 * @returns {Array<{ index: number, r: number, g: number, b: number, rawWord: number }>}
 */
export function decodeGenesisCRAM(cram) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const off = i * 2;
    // The gpgx `genesis_cram` buffer holds PACKED 9-bit colours, NOT the raw
    // 16-bit bus word: on a CRAM write gpgx repacks BBB0GGG0RRR0 → 0bBBBGGGRRR
    // (vdp_ctrl.c case 0x03) and stores that as a native uint16 → little-endian
    // on our WASM host. Read LE, then R=bits0-2, G=bits3-5, B=bits6-8.
    // (The old big-endian + bus-format masks made every colour blue.)
    const word = cram[off] | (cram[off + 1] << 8);
    const r3 = word & 0x7;
    const g3 = (word >> 3) & 0x7;
    const b3 = (word >> 6) & 0x7;
    // Expand 3-bit to 8-bit: replicate top bits (Genesis uses a non-linear
    // ladder in hardware, but the (n << 5) | (n << 2) | (n >> 1) form is
    // what most reference emulators output).
    const expand = (n3) => (n3 << 5) | (n3 << 2) | (n3 >> 1);
    out.push({
      index: i,
      r: expand(r3),
      g: expand(g3),
      b: expand(b3),
      rawWord: word,
    });
  }
  return out;
}

// ---- VDP sprite list decoder ------------------------------------------
//
// Genesis sprites live in VRAM at the address pointed to by VDP register
// $05 (low byte) × $0200. Each sprite is 8 bytes:
//   word 0 (Y): bits 0-9 = Y position + 128 (so visible Y = stored - 128)
//   word 1: bits 0-1 = size W (0=8, 1=16, 2=24, 3=32 px)
//           bits 8-9 = size H (same encoding × 8)
//           bits 0-6 of low byte = link field (next sprite index, 0=last)
//   word 2: bit 15 = priority, bits 13-14 = palette (0-3),
//           bit 12 = vflip, bit 11 = hflip, bits 0-10 = tile index
//   word 3: bits 0-8 = X position + 128
//
// Sprites are walked as a linked list starting at index 0 via the link
// field; max 80 sprites per frame. Reading raw bytes from VRAM is fine
// because video_ram is already a libretro standard region.
//
// We accept a vramBytes buffer + the sprite-table base offset (resolved
// from VDP reg $05).

// ---- PSG (SN76489-style) decoder ---------------------------------------
//
// gpgx's PSG context (psg_context_save) layout per psg.c:
//   [4 bytes int LE]    clocks
//   [4 bytes int LE]    latch
//   [4 bytes int LE]    noiseShiftValue
//   [32 bytes int[8]]   regs[8]      ← what we actually care about
//   [16 bytes int[4]]   freqInc[4]
//   [16 bytes int[4]]   freqCounter[4]
//   [16 bytes int[4]]   polarity[4]
//   [32 bytes int[4][2]] chanOut[4][2]
//
// regs[i*2]   = frequency/volume LATCH for channel i (top 4 bits = channel,
//               next 1 bit = type [tone/vol], remaining = value)
// regs[i*2+1] = (chan 0..2) frequency high bits; (chan 3) noise mode
//
// We expose the per-channel decoded form: 3 tone channels (freq, attenuation
// 0-15) + 1 noise (mode, rate, attenuation).
/**
 * @param {Uint8Array} blob psg context blob (1KB scratch)
 * @returns {{
 *   tones: Array<{ channel: number, frequency: number, attenuation: number }>,
 *   noise: { rate: number, mode: 'white'|'periodic', attenuation: number },
 *   raw: { clocks: number, latch: number, noiseShiftValue: number },
 * }}
 */
export function decodeGenesisPSG(blob) {
  const u32 = (off) => blob[off] | (blob[off + 1] << 8) | (blob[off + 2] << 16) | (blob[off + 3] << 24);
  const clocks = u32(0);
  const latch = u32(4);
  const noiseShiftValue = u32(8);
  // regs[] starts at offset 12 (after 3 ints). 8 ints x 4 = 32 bytes.
  // gpgx stores each SN76489 register widened to a host int, so these are
  // 32-bit reads of what the chip documents as 4/10-bit fields.
  const regs = [];
  for (let i = 0; i < 8; i++) regs.push(u32(12 + i * 4));

  // The SN76489 divides its input clock by 16, and each tone channel toggles
  // its output every `period` ticks -- so one full cycle is TWO toggles:
  //     Hz = clock / 16 / (2 * period)
  // Both the Genesis and SMS/GG PSG run from the same 3.579545 MHz NTSC
  // colourburst clock, so one constant covers every platform this decoder
  // serves.
  const PSG_CLOCK_HZ = 3579545;
  const toneHz = (period) => (period > 0 ? PSG_CLOCK_HZ / 16 / (2 * period) : 0);

  const tones = [];
  for (let c = 0; c < 3; c++) {
    // 10-bit period: low 4 bits in the channel's first register, upper 6 in
    // the second. (The raw struct value depends on the last write; reading
    // writes is the canonical route, this is the cheap "what is it playing
    // now" view.)
    const period = ((regs[c * 2 + 1] & 0x3F) << 4) | (regs[c * 2] & 0x0F);
    const attenuation = regs[c * 2 + 1] & 0x0F;
    tones.push({
      channel: c,
      // `period` is the register value; `frequency` is Hz. These used to be
      // one field named `frequency` that actually carried the PERIOD, which
      // made the numbers irreconcilable with raw.regsHex and sent at least
      // one caller hunting for a clock constant that could not exist (solving
      // clock = f*32*period against a period-as-Hz gives 3.45M/3.74M/5.67M --
      // three different "clocks", the signature of a mislabelled field).
      period,
      frequency: Math.round(toneHz(period) * 10) / 10,
      attenuation,                 // 0 = loudest, 15 = silent
      attenuationRaw: attenuation, // kept: older callers read this name
      muted: attenuation === 0x0F,
    });
  }
  const noiseAtt = regs[7] & 0x0F;
  const noise = {
    rate: regs[6] & 0x03,                   // 0/1/2 = clock/512,1024,2048; 3 = ch2 period
    mode: (regs[6] & 0x04) ? 'white' : 'periodic',
    attenuation: noiseAtt,
    attenuationRaw: noiseAtt,
    muted: noiseAtt === 0x0F,
  };
  return {
    tones,
    noise,
    raw: {
      clocks, latch, noiseShiftValue,
      // Per-register values as gpgx stores them (host ints, hence >8 bits).
      // tones[].period is derived from exactly these: for channel c,
      //   period = ((regs[2c+1] & 0x3F) << 4) | (regs[2c] & 0x0F)
      //   attenuation = regs[2c+1] & 0x0F
      regsHex: regs.map((r) => r.toString(16)).join(","),
      regsNote: "gpgx-internal SN76489 register file, one host int per register. "
        + "Derive a channel with period = ((regs[2c+1] & 0x3F) << 4) | (regs[2c] & 0x0F), "
        + "attenuation = regs[2c+1] & 0x0F. Hz = 3579545/16/(2*period).",
      psgClockHz: PSG_CLOCK_HZ,
    },
  };
}

// ---- YM2612 decoder ----------------------------------------------------
//
// gpgx's YM2612 internal struct is large and implementation-private. We
// decode what's safely reachable: the dacen flag + dacout value (DAC sample
// stream - the "PCM voice" many Genesis games use). Full
// per-channel envelope state requires walking FM_CH/FM_SLOT internals
// whose layout isn't stable across gpgx versions; that's deferred.
//
// gpgx YM2612SaveContext writes:
//   [sizeof(ym2612) bytes]  ym2612 struct (CH[6] + dacen + dacout + OPN)
//   [24 bytes]              DT table indices (one per slot per channel)
//
// The struct starts with `FM_CH CH[6]`. FM_CH is large (operators + state)
// so we can't safely decode without pinning to a specific gpgx version.
// What WE expose: a stable summary derived from blob analysis - the dacen
// + dacout bytes at known offsets after the CH array.
//
// Caller can still get the raw blob via readMemory("genesis_ym2612") and
// hand-decode if they need internals.
/**
 * @param {Uint8Array} blob ym2612 context (4KB scratch, ~1.5KB used)
 * @returns {{ note: string, blobBytes: number, rawHex: string }}
 */
export function decodeGenesisYM2612(blob) {
  // Find length of meaningful blob - gpgx zero-fills past actual size.
  let len = blob.length;
  while (len > 0 && blob[len - 1] === 0) len--;
  // First few bytes are the FM_CH[0] struct start; not stable to decode
  // here without struct layout. Return a forensic snapshot the agent can
  // diff between frames or against a known-good reference.
  return {
    note: "YM2612 internal state is implementation-private; this is a raw snapshot. For now: diff blobs between frames to detect changes, or compare against a reference recording. Stable per-channel decode requires the YM2612 register write log, which gpgx doesn't currently expose.",
    blobBytes: len,
    // Just first 128 bytes hex; full blob available via readMemory.
    rawHex: Array.from(blob.slice(0, 128), (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

/**
 * @param {Uint8Array} vram 64KB
 * @param {Uint8Array} vdpRegs 32 bytes
 * @returns {Array<{slot, x, y, tile, palette, priority, flipH, flipV, size:{w,h}, link, visible, raw}>}
 */
export function decodeGenesisSprites(vram, vdpRegs) {
  // VDP reg $05 = sprite attribute table address / $0200.
  // For 256-pixel-wide screen, valid base is bits 0-6 (×0x200 = max 0x7E00).
  // For 320-pixel-wide screen, bit 0 is ignored (×0x400).
  const reg5 = vdpRegs[0x05];
  // Read reg $0C bit 0 to distinguish H32/H40 (= 256 vs 320 wide).
  const h40 = (vdpRegs[0x0C] & 0x01) !== 0;
  const baseAddr = h40
    ? ((reg5 & 0x7E) << 9) // 0x400 step
    : (reg5 << 9);          // 0x200 step
  const maxSprites = h40 ? 80 : 64;

  const sprites = [];
  let slot = 0;
  // Linked-list walk via link field. Cap at maxSprites to defend against
  // a bad link byte creating an infinite loop.
  let visited = new Set();
  for (let i = 0; i < maxSprites; i++) {
    if (visited.has(slot)) break;
    visited.add(slot);
    const off = (baseAddr + slot * 8) & 0xFFFF;
    if (off + 8 > 0x10000) break;
    // gpgx stores VRAM as 16-bit words in HOST (little-endian) byte order, so
    // each logical VDP word's two bytes are SWAPPED in this raw buffer. Read the
    // SAT words little-endian (low byte first). Verified live: a 32×32 sprite's
    // size/link word is bytes `00 0f` here = logical 0x0F00; reading it BE gave
    // 0x000F → wrong 8×8 size + bogus link 15. The same swap applies to Y/X/attr
    // (Y bytes `e4 00` = logical 0x00E4 = 228). Previously these were read BE,
    // which mis-decoded sprite size/link (and would corrupt X/Y for X≥256/Y≥256).
    const yWord = (vram[off + 1] << 8) | vram[off];
    const sizeLinkWord = (vram[off + 3] << 8) | vram[off + 2];
    const tileWord = (vram[off + 5] << 8) | vram[off + 4];
    const xWord = (vram[off + 7] << 8) | vram[off + 6];

    const sizeH = (sizeLinkWord >> 8) & 0x3;        // bits 8-9
    const sizeW = (sizeLinkWord >> 10) & 0x3;       // bits 10-11
    const link = sizeLinkWord & 0x7F;
    const tile = tileWord & 0x07FF;
    const flipH = !!(tileWord & 0x0800);
    const flipV = !!(tileWord & 0x1000);
    const palette = (tileWord >> 13) & 0x3;
    const priority = (tileWord >> 15) & 0x1;
    const y = (yWord & 0x3FF) - 128;
    const x = (xWord & 0x1FF) - 128;
    const wPx = (sizeW + 1) * 8;
    const hPx = (sizeH + 1) * 8;

    sprites.push({
      slot,
      x, y, tile, palette, priority,
      flipH, flipV,
      size: { w: wPx, h: hPx },
      link,
      visible: y > -hPx && y < 240 && x > -wPx && x < (h40 ? 320 : 256),
      raw: { yWord, sizeLinkWord, tileWord, xWord },
    });

    if (link === 0) break;
    slot = link;
  }
  return sprites;
}

/**
 * Decode the SMS/GG/Genesis VDP register file into named, interpreted fields.
 *
 * The raw 16-byte region is already readable via memory({region:'sms_vdp_regs'}),
 * but a byte dump does not tell you that bit 6 of R1 is the display enable or
 * that R2 holds the name-table base in units of $400. This is the same "decoded,
 * named view of live chip state" shape audioDebug({chip:'psg'}) has.
 *
 * WHAT IS NOT HERE, and why: the VDP's control LATCH, STATUS register and
 * current VRAM ADDRESS/CODE are genuinely not exposed by the core's memory API
 * (the region is 16 bytes and stops at the register file). They live inside
 * gpgx's own VDP struct, reachable only by decoding a savestate blob whose
 * layout is not stable across gpgx versions -- the same reason this file
 * refuses to decode the YM2612 channel structs. Guessing an offset there would
 * produce confident, version-dependent nonsense.
 *
 * @param {Uint8Array} regs the sms_vdp_regs region (>= 11 bytes)
 * @param {string} platform 'sms' | 'gg' | 'genesis'
 */
export function decodeVdpRegisters(regs, platform = "sms") {
  const r = (i) => (regs?.[i] ?? 0) & 0xff;
  const bit = (v, n) => ((v >> n) & 1) === 1;
  const r0 = r(0), r1 = r(1);
  return {
    platform,
    mode: {
      // Mode-control 1 ($80) and 2 ($81) -- the two registers that decide what
      // the chip is even doing, which a raw dump hides behind bit positions.
      displayEnabled: bit(r1, 6),
      vblankIrqEnabled: bit(r1, 5),
      lineIrqEnabled: bit(r0, 4),
      spriteSize16: bit(r1, 1),
      spriteZoom: bit(r1, 0),
      maskColumn0: bit(r0, 5),
      hScrollLock: bit(r0, 6),
      vScrollLock: bit(r0, 7),
      shiftSprites: bit(r0, 3),
      mode4: bit(r0, 2),
      raw: { r0, r1 },
    },
    // Table bases. The VDP stores these divided down, so the multiplied value
    // is what you actually compare against a VRAM address.
    tables: {
      nameTableBase: (r(2) & 0x0e) << 10,
      nameTableBaseHex: `$${(((r(2) & 0x0e) << 10) >>> 0).toString(16).padStart(4, "0")}`,
      spriteAttrBase: (r(5) & 0x7e) << 7,
      spriteAttrBaseHex: `$${(((r(5) & 0x7e) << 7) >>> 0).toString(16).padStart(4, "0")}`,
      spritePatternBase: (r(6) & 0x04) << 11,
      spritePatternBaseHex: `$${(((r(6) & 0x04) << 11) >>> 0).toString(16).padStart(4, "0")}`,
    },
    scroll: { x: r(8), y: r(9) },
    lineCounter: r(10),
    borderColor: r(7) & 0x0f,
    registers: Array.from({ length: 11 }, (_, i) => ({ index: i, value: r(i), hex: `$${r(i).toString(16).padStart(2, "0")}` })),
    unavailable: {
      fields: ["controlLatch", "statusRegister", "vramAddress", "vramCode"],
      reason: "not exposed by the core's memory API (sms_vdp_regs is the 16-byte register file). "
        + "They live in gpgx's internal VDP struct, whose savestate layout is not stable across "
        + "core versions -- decoding it by offset would return confident nonsense after any core bump. "
        + "For status-register behaviour (e.g. unused bits reading as 1), breakpoint({on:'read', address}) "
        + "on the status port shows the value the game actually observes.",
    },
  };
}
