/* Freestanding stand-in for snes9x's memmap.h: the CMemory fields and the
 * map enum the coprocessor sources touch (scripts/recompile-gen/snes9x-chips.mjs).
 * The enum order is snes9x's (memmap.h), so a Map[] entry the BS-X code
 * stores means what it means in snes9x; the glue translates Map[] into the
 * cart's own block table. */
#ifndef _MEMMAP_H_
#define _MEMMAP_H_

#define MEMMAP_BLOCK_SIZE	(0x1000)
#define MEMMAP_NUM_BLOCKS	(0x1000000 / MEMMAP_BLOCK_SIZE)
#define MEMMAP_SHIFT		(12)
#define MEMMAP_MASK			(MEMMAP_BLOCK_SIZE - 1)

class CMemory
{
public:
	enum
	{ MAP_TYPE_I_O, MAP_TYPE_ROM, MAP_TYPE_RAM };

	enum
	{
		MAP_CPU,
		MAP_PPU,
		MAP_LOROM_SRAM,
		MAP_LOROM_SRAM_B,
		MAP_HIROM_SRAM,
		MAP_DSP,
		MAP_SA1RAM,
		MAP_BWRAM,
		MAP_BWRAM_BITMAP,
		MAP_BWRAM_BITMAP2,
		MAP_SPC7110_ROM,
		MAP_SPC7110_DRAM,
		MAP_RONLY_SRAM,
		MAP_C4,
		MAP_OBC_RAM,
		MAP_SETA_DSP,
		MAP_SETA_RISC,
		MAP_BSX,
		MAP_NONE,
		MAP_LAST
	};

	uint8	*RAM;
	uint8	*ROM;
	uint8	*SRAM;
	uint8	*BWRAM;
	uint8	*OBC1RAM;
	uint8	*BSRAM;
	uint8	*BIOSROM;
	uint32	SRAMMask;
	int32	CalculatedSize;
	bool8	LoROM;
	bool8	HiROM;

	uint8	*Map[MEMMAP_NUM_BLOCKS];
	uint8	BlockIsRAM[MEMMAP_NUM_BLOCKS];
	uint8	BlockIsROM[MEMMAP_NUM_BLOCKS];

	void map_WriteProtectROM (void);

	/* the CX4's 8KB (c4.cpp); last, so the fields above keep their offsets */
	uint8	*C4RAM;
};

struct SMulti
{
	int		cartType;
	int32	cartSizeA, cartSizeB;
	int32	sramSizeA, sramSizeB;
	uint32	sramMaskA, sramMaskB;
	uint32	cartOffsetA, cartOffsetB;
	uint8	*sramA, *sramB;
};

extern CMemory		Memory;
extern struct SMulti	Multi;

#endif
