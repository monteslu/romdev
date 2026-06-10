/* MSX VDP + PSG + input helpers (SDCC z80, C89) — DIRECT-PORT implementation.
 *
 * The previous version drove the BIOS through `ld c,4(ix)` inline asm. That is
 * broken under SDCC's default `--sdcccall 1`: the first argument is passed in a
 * register, so 4(ix) reads a stale stack slot — msx_wrtvdp(7,0x55) wrote 0xF5
 * instead of 0x55. Everything here goes straight to the Z80 I/O ports declared
 * in msx_hw.h, so the C arguments are used exactly as written. Verified on the
 * bluemsx core.
 *
 * VDP register write (the canonical sequence, no BIOS needed):
 *   VDPCTRL = value;              ; data byte first
 *   VDPCTRL = 0x80 | reg;         ; then the register selector
 * VRAM address set:
 *   VDPCTRL = addr & 0xFF;        ; low byte
 *   VDPCTRL = ((addr>>8)&0x3F) | flag;  flag = 0x40 write / 0x00 read
 * then stream/read bytes through VDPDATA (auto-increments).
 */
#include "msx_hw.h"

/* Set the VDP autoincrement write pointer to a VRAM address. */
static void vram_set_write(uint16_t addr) {
    VDPCTRL = (uint8_t)(addr & 0xFF);
    VDPCTRL = (uint8_t)(((addr >> 8) & 0x3F) | VDP_VRAM_WRITE);
}

/* Write one VDP register (R0..R23 on the V9938). */
void msx_wrtvdp(uint8_t reg, uint8_t value) {
    VDPCTRL = value;
    VDPCTRL = (uint8_t)(0x80 | reg);
}

/* Initialise screen 2 (GRAPHIC II): 256x192, pattern/colour/name/sprite tables
 * laid out per msx_hw.h's VRAM_* defines. We let the BIOS INIGRP set the base
 * registers + clear VRAM (it also wires the interrupt + slot state correctly),
 * which avoids hand-poking every register. INIGRP needs no arguments, so the
 * bare `call` is safe under any calling convention. */
void msx_set_screen2(void) {
    __asm
        call #0x0072            ; INIGRP — screen 2, clear VRAM, display on
    __endasm;
}

/* Copy len bytes from RAM into VRAM starting at addr (auto-increment). */
void msx_vram_write(uint16_t addr, const uint8_t *src, uint16_t len) {
    vram_set_write(addr);
    while (len--) {
        VDPDATA = *src++;
    }
}

/* Fill len VRAM bytes from addr with a constant byte. */
void msx_fill_vram(uint16_t addr, uint16_t len, uint8_t byte) {
    vram_set_write(addr);
    while (len--) {
        VDPDATA = byte;
    }
}

/* Set one V9938 palette entry (MSX2). `grb` packs 3-bit components as
 * 0x0GRB-ish: bits 8..10 = green, bits 4..6 = red, bits 0..2 = blue. The V9938
 * protocol: point R16 (colour pointer) at the index, then write two bytes to
 * port 0x9A — first (red<<4)|blue, then green. */
void msx_set_palette_entry(uint8_t idx, uint16_t grb) {
    uint8_t r = (uint8_t)((grb >> 4) & 0x07);
    uint8_t g = (uint8_t)((grb >> 8) & 0x07);
    uint8_t b = (uint8_t)(grb & 0x07);
    msx_wrtvdp(16, (uint8_t)(idx & 0x0F)); /* R16 = palette index */
    VDPPAL = (uint8_t)((r << 4) | b);      /* byte 0: RRRR_0BBB */
    VDPPAL = (uint8_t)(g);                 /* byte 1: 0000_0GGG */
}

/* Write one sprite into the screen-2 sprite-attribute table.
 * Each OAM entry is 4 bytes: Y, X, pattern, colour(+ EC/tag bits). */
void msx_set_sprite(uint8_t plane, uint8_t x, uint8_t y,
                    uint8_t pattern, uint8_t color) {
    uint16_t addr = (uint16_t)(VRAM_SPRATTR + ((uint16_t)plane << 2));
    vram_set_write(addr);
    VDPDATA = y;
    VDPDATA = x;
    VDPDATA = pattern;
    VDPDATA = color;
}

/* Hide every sprite by terminating the OAM scan at plane 0 (Y=0xD0). */
void msx_clear_sprites(void) {
    uint8_t i;
    vram_set_write(VRAM_SPRATTR);
    for (i = 0; i < 32; i++) {
        VDPDATA = SPRITE_END_Y; /* Y = 208 terminates / parks the sprite */
        VDPDATA = 0;
        VDPDATA = 0;
        VDPDATA = 0;
    }
}

/* Spin until the BIOS frame counter (JIFFY, $FC9E low byte) advances — i.e.
 * until the next VBlank interrupt has been serviced. Reading a fixed RAM
 * address is convention-independent, so plain asm is fine here. */
void msx_vblank_wait(void) {
    __asm
        ld   hl, #0xFC9E       ; JIFFY low byte (incremented each VBlank ISR)
        ld   a, (hl)
000001$:
        cp   a, (hl)
        jr   z, 000001$
    __endasm;
}

/* Read a joystick (0 = keyboard cursor, 1/2 = ports). Returns 0=center,
 * 1-8 = direction clockwise from up. Uses the BIOS GTSTCK via the clean
 * function-pointer cast (A in / A out). */
uint8_t msx_read_joystick(uint8_t stick) {
    return gtstck(stick);
}

/* Play a square-tone on PSG channel 0/1/2 at the given 12-bit period and
 * volume 0-15. Clears the matching tone-disable bit in the mixer (reg 7, the
 * mixer is active-LOW: a clear bit enables that channel's tone). */
void msx_psg_tone(uint8_t chan, uint16_t period, uint8_t vol) {
    uint8_t mixer;
    uint8_t fine = (uint8_t)(period & 0xFF);
    uint8_t coarse = (uint8_t)((period >> 8) & 0x0F);

    /* DI around the whole register sequence: the BIOS KEYINT ISR reads
     * PSG R14 (joystick row) every frame, and it CLOBBERS the PSGADDR
     * latch — an IRQ between our PSGADDR and PSGWRITE sent the period/
     * volume bytes into R14 instead. Symptom: mixer set, period 0,
     * amplitude 0 → every MSX scaffold was silent. */
    __asm__("di");

    /* tone period: regs 0/1 (A), 2/3 (B), 4/5 (C) */
    PSGADDR = (uint8_t)(chan << 1);       PSGWRITE = fine;
    PSGADDR = (uint8_t)((chan << 1) + 1); PSGWRITE = coarse;

    /* volume: regs 8/9/10 */
    PSGADDR = (uint8_t)(8 + chan);        PSGWRITE = (uint8_t)(vol & 0x0F);

    /* mixer (reg 7): clear this channel's tone bit (bits 0-2), keep noise off
     * (bits 3-5 set) and the two I/O-direction bits (6,7) set for output. */
    PSGADDR = 7;
    mixer = PSGREAD;
    mixer |= 0x38;                         /* noise off for all 3 channels   */
    mixer &= (uint8_t)~(1 << chan);        /* tone ON for this channel       */
    PSGADDR = 7;
    PSGWRITE = mixer;
    __asm__("ei");
}

/* Silence a PSG channel: zero its volume and re-disable its tone bit. */
void msx_psg_off(uint8_t chan) {
    uint8_t mixer;
    __asm__("di");                                /* same KEYINT race as above */
    PSGADDR = (uint8_t)(8 + chan); PSGWRITE = 0;  /* volume 0 */
    PSGADDR = 7;
    mixer = PSGREAD;
    mixer |= (uint8_t)(1 << chan);                /* tone OFF for this channel */
    PSGADDR = 7;
    PSGWRITE = mixer;
    __asm__("ei");
}

/* ── background music: 16-step melody loop on PSG channel C (2) ─────
 * Call msx_music_tick() once per frame (the scaffolds wire it in after
 * their vsync wait); msx_music(0) turns it off. SFX use channels A/B,
 * so effects always cut through. AY period = 1789773 / (16 * freq). */
static const uint16_t _msx_music_per[16] = {
    427, 339, 285, 214, 285, 339, 427, 0,    /* C4 E4 G4 C5 G4 E4 C4 -  */
    508, 427, 339, 254, 339, 427, 508, 0,    /* A3 C4 E4 A4 E4 C4 A3 -  */
};
static uint8_t _msx_music_on = 1;
static uint8_t _msx_music_step;
static uint8_t _msx_music_timer;

void msx_music(uint8_t on) {
    _msx_music_on = on;
    _msx_music_step = 0;
    _msx_music_timer = 0;
    if (!on) msx_psg_off(2);
}

void msx_music_tick(void) {
    uint16_t p;
    if (!_msx_music_on) return;
    if (_msx_music_timer == 0) {
        p = _msx_music_per[_msx_music_step & 15];
        if (p) {
            msx_psg_tone(2, p, 12);            /* AY volume is ~logarithmic — 9 was a whisper */
        } else {
            msx_psg_off(2);                    /* rest */
        }
        ++_msx_music_step;
    }
    ++_msx_music_timer;
    if (_msx_music_timer >= 9) _msx_music_timer = 0;
}
