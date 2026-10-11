/* romdev: the chip data ROM tables snes9x's DSP-1, DSP-3 and ST010
 * emulation reads, filled from the user's copy of the chip's data ROM.
 *
 * Upstream snes9x embeds those tables (the chips' mask-ROM data); romdev
 * builds snes9x with them emptied (snes9x-chips/hle-data.mjs) and fills them
 * here, the same way in the snes9x core (scripts/patches/snes9x/
 * romdev_hledata.cpp) and in a recompiled cart's chip units (glue_dsp.cpp,
 * glue_seta.cpp). The data ROM is 16-bit little-endian words, as emulators
 * dump it (dsp1b.data.rom, dsp3.data.rom, st010.data.rom; the files are
 * named in src/analysis/recompile/wat/snes/hle-data.js).
 *
 * Define ROMDEV_HLEDATA_DSP (dsp1.cpp, dsp3.cpp) and / or
 * ROMDEV_HLEDATA_ST010 (seta010.cpp) for the tables linked with the code. */
#ifndef ROMDEV_HLEDATA_H
#define ROMDEV_HLEDATA_H

#define ROMDEV_HLEDATA_W(d, i) ((uint16) ((d)[2 * (i)] | ((d)[2 * (i) + 1] << 8)))

#ifdef ROMDEV_HLEDATA_DSP
extern uint16	DSP1ROM[1024];
extern int16	DSP1_SinTable[256];
extern uint16	DSP3_DataROM[1024];
#endif
#ifdef ROMDEV_HLEDATA_ST010
extern int16	ST010_SinTable[256];
extern int16	ST010_M7Scale[176];
#endif

/* FNV-1a 32 of n bytes: the check that a file is the data ROM snes9x's
 * emulation was written against (hle-data.js HLE_DATA[].fnv). */
static inline uint32 romdev_hledata_fnv (const uint8 *d, uint32 n)
{
	uint32 h = 0x811c9dc5u;
	for (uint32 i = 0; i < n; i++)
		h = (h ^ d[i]) * 0x01000193u;
	return h;
}

/* Fill the tables of chip `id` (1 DSP-1, 3 DSP-3, 10 ST010) from its data ROM
 * `d`. Returns 0, or -1 for a chip this build has no tables for. */
static inline int romdev_hledata_install (int id, const uint8 *d)
{
	switch (id)
	{
#ifdef ROMDEV_HLEDATA_DSP
		case 1:
			for (int i = 0; i < 1024; i++)
				DSP1ROM[i] = ROMDEV_HLEDATA_W(d, i);
			/* dsp1.cpp's sine table: the data ROM's 128 words from 0x116,
			 * then the same words negated */
			for (int i = 0; i < 128; i++)
			{
				DSP1_SinTable[i] = (int16) ROMDEV_HLEDATA_W(d, 0x116 + i);
				DSP1_SinTable[128 + i] = (int16) -DSP1_SinTable[i];
			}
			return 0;
		case 3:
			for (int i = 0; i < 1024; i++)
				DSP3_DataROM[i] = ROMDEV_HLEDATA_W(d, i);
			return 0;
#endif
#ifdef ROMDEV_HLEDATA_ST010
		case 10:
			/* seta010.cpp's tables: the mode 7 scale table is the data ROM's
			 * first 176 words, the sine table the 256 after it */
			for (int i = 0; i < 176; i++)
				ST010_M7Scale[i] = (int16) ROMDEV_HLEDATA_W(d, i);
			for (int i = 0; i < 256; i++)
				ST010_SinTable[i] = (int16) ROMDEV_HLEDATA_W(d, 176 + i);
			return 0;
#endif
	}
	return -1;
}

#endif
