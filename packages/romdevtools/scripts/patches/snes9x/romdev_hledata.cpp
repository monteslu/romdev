/* romdev: the data ROM tables snes9x's DSP-1, DSP-3 and ST010 emulation
 * reads, from the system directory.
 *
 * Upstream snes9x embeds those tables (the chips' mask-ROM data). romdev
 * ships none of them: scripts/build-snes9x.sh empties them
 * (scripts/recompile-gen/snes9x-chips/hle-data.mjs) and this file fills them
 * from the user's copy of the chip's data ROM when such a cart loads, with
 * the same code a recompiled cart's chip unit uses (romdev_hledata.h). The
 * file is the data ROM (dsp1b.data.rom, dsp3.data.rom, st010.data.rom) or the
 * whole firmware, program ROM then data ROM (dsp1b.rom, dsp3.rom,
 * st010.rom). Without it, or with a file that is not the data ROM snes9x's
 * emulation was written against (for the DSP-1, the DSP-1B's, which snes9x
 * uses for every DSP-1 cart), the cart is refused: romdev_hledata_error is
 * set and libretro.cpp's retro_load_game logs it and fails.
 * scripts/patches/snes9x-romdev-hle-data.patch calls this from memmap.cpp
 * (InitROM) and libretro.cpp. The names, sizes and hashes match
 * src/analysis/recompile/wat/snes/hle-data.js. This file is romdev's (MIT). */
#include <stdio.h>
#include <string>
#include "snes9x.h"
#include "memmap.h"
#include "display.h"
#include "fscompat.h"
#define ROMDEV_HLEDATA_DSP
#define ROMDEV_HLEDATA_ST010
#include "romdev_hledata.h"

char romdev_hledata_error[512];

struct romdev_hledata_chip
{
	int		id;
	const char	*chip, *data, *whole, *what;
	uint32		dataSize, programSize, used, fnv;
};

static const romdev_hledata_chip romdev_hledata_chips[] = {
	{ 1, "DSP-1", "dsp1b.data.rom", "dsp1b.rom", "the DSP-1B's data ROM", 0x800, 0x1800, 0x800, 0x4ce5ea75u },
	{ 3, "DSP-3", "dsp3.data.rom", "dsp3.rom", "the DSP-3's data ROM", 0x800, 0x1800, 0x800, 0xc460f315u },
	{ 10, "ST010", "st010.data.rom", "st010.rom", "the ST010's data ROM", 0x1000, 0xc000, 0x360, 0xe6fa7eedu },
};

static uint8 romdev_hledata_buf[0xd000 + 1];

/* the file's length (up to max + 1, so a longer file reads as too long), or -1 */
static long romdev_hledata_read (const char *name, uint32 max)
{
	std::string path = S9xGetDirectory(BIOS_DIR) + SLASH_STR + name;
	FILE *f = fopen(path.c_str(), "rb");
	if (!f)
		return -1;
	size_t n = fread(romdev_hledata_buf, 1, max + 1, f);
	fclose(f);
	return (long) n;
}

/* memmap.cpp InitROM, after the chip is chosen: id 1 (DSP-1), 3 (DSP-3),
 * 10 (ST010), or 0 for a cart that needs no data ROM */
void romdev_hledata_select (int id)
{
	romdev_hledata_error[0] = 0;
	const romdev_hledata_chip *c = NULL;
	for (unsigned i = 0; i < sizeof(romdev_hledata_chips) / sizeof(romdev_hledata_chips[0]); i++)
		if (romdev_hledata_chips[i].id == id)
			c = &romdev_hledata_chips[i];
	if (!c)
		return;

	const uint8 *d = NULL;
	const char *name = c->data;
	if (romdev_hledata_read(c->data, c->dataSize) == (long) c->dataSize)
		d = romdev_hledata_buf;
	else if (romdev_hledata_read(c->whole, c->programSize + c->dataSize) == (long) (c->programSize + c->dataSize))
	{
		d = romdev_hledata_buf + c->programSize;
		name = c->whole;
	}

	if (!d)
	{
		snprintf(romdev_hledata_error, sizeof(romdev_hledata_error),
			"romdev: this cart uses the %s, whose emulation reads the chip's data ROM, which romdev does not ship. "
			"Put the user's copy in the system directory as %s (%u bytes, %s) or %s (%u bytes, the program ROM then the data ROM).\n",
			c->chip, c->data, (unsigned) c->dataSize, c->what, c->whole, (unsigned) (c->programSize + c->dataSize));
		return;
	}
	if (romdev_hledata_fnv(d, c->used) != c->fnv)
	{
		snprintf(romdev_hledata_error, sizeof(romdev_hledata_error),
			"romdev: %s in the system directory is not %s: the %u bytes snes9x's %s emulation reads do not match.\n",
			name, c->what, (unsigned) c->used, c->chip);
		return;
	}
	romdev_hledata_install(c->id, d);
}
