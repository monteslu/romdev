/* romdev: a coprocessor's internal state as one flat byte string, so a
 * recompiled cart and the reference core can be compared on it.
 *
 * ONE definition, compiled on both sides: the snes9x core build copies this
 * file next to libretro.cpp (scripts/build-snes9x.sh), which serves it as the
 * snes_chipstate memory region (ROMDEV_MEMORY_SNES_CHIPSTATE, assembled on
 * read), and the chip units of scripts/recompile-gen/snes9x-chips.mjs call
 * the same functions from their glue, so the cart writes the same bytes into
 * its own chipstate region at the end of each frame.
 *
 * Fields are copied one by one (never a whole struct: padding would be
 * compared) in declaration order, using snes9x's own save-state view of a
 * chip where it has one (S9xSPC7110PreSaveState / S9xSRTCPreSaveState fill
 * s7snap / srtcsnap from the chip objects, nothing else). A chip's section is
 * compiled only where its objects are declared: define ROMDEV_CS_DSP3,
 * ROMDEV_CS_SETA, ROMDEV_CS_SRTC, ROMDEV_CS_SPC7110 or ROMDEV_CS_BSX before
 * including this file.
 *
 * Every function returns the number of bytes written (at most
 * ROMDEV_CHIPSTATE_MAX). */
#ifndef ROMDEV_CHIPSTATE_H
#define ROMDEV_CHIPSTATE_H

#define ROMDEV_CHIPSTATE_MAX	0x10000

#define RCS(x)		do { __builtin_memcpy(o + n, &(x), sizeof(x)); n += sizeof(x); } while (0)
#define RCS_ARR(x)	do { __builtin_memcpy(o + n, (x), sizeof(x)); n += sizeof(x); } while (0)

#ifdef ROMDEV_CS_DSP3
static unsigned romdev_cs_dsp3 (uint8 *o)
{
	unsigned n = 0;
	RCS(DSP3.DR); RCS(DSP3.SR); RCS(DSP3.MemoryIndex);
	RCS(DSP3.WinLo); RCS(DSP3.WinHi); RCS(DSP3.AddLo); RCS(DSP3.AddHi);
	RCS(DSP3.Codewords); RCS(DSP3.Outwords); RCS(DSP3.Symbol); RCS(DSP3.BitCount); RCS(DSP3.Index);
	RCS_ARR(DSP3.Codes);
	RCS(DSP3.BitsLeft); RCS(DSP3.ReqBits); RCS(DSP3.ReqData); RCS(DSP3.BitCommand);
	RCS(DSP3.BaseLength); RCS(DSP3.BaseCodes); RCS(DSP3.BaseCode);
	RCS_ARR(DSP3.CodeLengths); RCS_ARR(DSP3.CodeOffsets);
	RCS(DSP3.LZCode); RCS(DSP3.LZLength);
	RCS(DSP3.X); RCS(DSP3.Y);
	RCS_ARR(DSP3.Bitmap); RCS_ARR(DSP3.Bitplane);
	RCS(DSP3.BMIndex); RCS(DSP3.BPIndex); RCS(DSP3.Count);
	RCS(DSP3.op3e_x); RCS(DSP3.op3e_y);
	RCS_ARR(DSP3.op1e_terrain); RCS_ARR(DSP3.op1e_cost); RCS_ARR(DSP3.op1e_weight);
	RCS(DSP3.op1e_cell); RCS(DSP3.op1e_turn); RCS(DSP3.op1e_search);
	RCS(DSP3.op1e_x); RCS(DSP3.op1e_y);
	RCS(DSP3.op1e_min_radius); RCS(DSP3.op1e_max_radius);
	RCS(DSP3.op1e_max_search_radius); RCS(DSP3.op1e_max_path_radius);
	RCS(DSP3.op1e_lcv_radius); RCS(DSP3.op1e_lcv_steps); RCS(DSP3.op1e_lcv_turns);
	/* the shared DSP port (dsp.cpp's SDSP0 is the map type and boundary only) */
	return n;
}
#endif

#ifdef ROMDEV_CS_SETA
static unsigned romdev_cs_st011 (uint8 *o)
{
	unsigned n = 0;
	RCS(ST011.waiting4command); RCS(ST011.status); RCS(ST011.command);
	RCS(ST011.in_count); RCS(ST011.in_index); RCS(ST011.out_count); RCS(ST011.out_index);
	RCS_ARR(ST011.parameters); RCS_ARR(ST011.output);
	return n;
}
static unsigned romdev_cs_st018 (uint8 *o)
{
	unsigned n = 0;
	RCS(ST018.waiting4command); RCS(ST018.status); RCS(ST018.part_command); RCS(ST018.pass);
	RCS(ST018.command); RCS(ST018.in_count); RCS(ST018.in_index); RCS(ST018.out_count); RCS(ST018.out_index);
	RCS_ARR(ST018.parameters); RCS_ARR(ST018.output);
	return n;
}
#endif

#ifdef ROMDEV_CS_SRTC
static unsigned romdev_cs_srtc (uint8 *o)
{
	unsigned n = 0;
	S9xSRTCPreSaveState();
	RCS(srtcsnap.rtc_mode); RCS(srtcsnap.rtc_index);
	RCS_ARR(RTCData.reg);
	return n;
}
#endif

#ifdef ROMDEV_CS_SPC7110
static unsigned romdev_cs_spc7110 (uint8 *o)
{
	unsigned n = 0;
	S9xSPC7110PreSaveState();
	RCS(s7snap.r4801); RCS(s7snap.r4802); RCS(s7snap.r4803); RCS(s7snap.r4804);
	RCS(s7snap.r4805); RCS(s7snap.r4806); RCS(s7snap.r4807); RCS(s7snap.r4808);
	RCS(s7snap.r4809); RCS(s7snap.r480a); RCS(s7snap.r480b); RCS(s7snap.r480c);
	RCS(s7snap.r4811); RCS(s7snap.r4812); RCS(s7snap.r4813); RCS(s7snap.r4814);
	RCS(s7snap.r4815); RCS(s7snap.r4816); RCS(s7snap.r4817); RCS(s7snap.r4818);
	RCS(s7snap.r481x); RCS(s7snap.r4814_latch); RCS(s7snap.r4815_latch);
	RCS(s7snap.r4820); RCS(s7snap.r4821); RCS(s7snap.r4822); RCS(s7snap.r4823);
	RCS(s7snap.r4824); RCS(s7snap.r4825); RCS(s7snap.r4826); RCS(s7snap.r4827);
	RCS(s7snap.r4828); RCS(s7snap.r4829); RCS(s7snap.r482a); RCS(s7snap.r482b);
	RCS(s7snap.r482c); RCS(s7snap.r482d); RCS(s7snap.r482e); RCS(s7snap.r482f);
	RCS(s7snap.r4830); RCS(s7snap.r4831); RCS(s7snap.r4832); RCS(s7snap.r4833); RCS(s7snap.r4834);
	RCS(s7snap.dx_offset); RCS(s7snap.ex_offset); RCS(s7snap.fx_offset);
	RCS(s7snap.r4840); RCS(s7snap.r4841); RCS(s7snap.r4842);
	RCS(s7snap.rtc_state); RCS(s7snap.rtc_mode); RCS(s7snap.rtc_index);
	RCS(s7snap.decomp_mode); RCS(s7snap.decomp_offset);
	RCS_ARR(s7snap.decomp_buffer);
	RCS(s7snap.decomp_buffer_rdoffset); RCS(s7snap.decomp_buffer_wroffset); RCS(s7snap.decomp_buffer_length);
	for (int i = 0; i < 32; i++) { RCS(s7snap.context[i].index); RCS(s7snap.context[i].invert); }
	RCS_ARR(RTCData.reg);
	return n;
}
#endif

#ifdef ROMDEV_CS_BSX
static unsigned romdev_cs_bsx (uint8 *o)
{
	unsigned n = 0;
	RCS(BSX.dirty); RCS(BSX.dirty2); RCS(BSX.bootup); RCS(BSX.flash_enable); RCS(BSX.write_enable); RCS(BSX.read_enable);
	RCS(BSX.flash_command); RCS(BSX.old_write); RCS(BSX.new_write);
	RCS(BSX.out_index); RCS_ARR(BSX.output); RCS_ARR(BSX.PPU); RCS_ARR(BSX.MMC); RCS_ARR(BSX.prevMMC); RCS_ARR(BSX.test2192);
	RCS(BSX.flash_csr); RCS(BSX.flash_gsr); RCS(BSX.flash_bsr); RCS(BSX.flash_cmd_done);
	/* the satellite data streams (std::ifstream) are files, not state */
	RCS(BSX.sat_pf_latch1_enable); RCS(BSX.sat_dt_latch1_enable);
	RCS(BSX.sat_pf_latch2_enable); RCS(BSX.sat_dt_latch2_enable);
	RCS(BSX.sat_stream1_loaded); RCS(BSX.sat_stream2_loaded);
	RCS(BSX.sat_stream1_first); RCS(BSX.sat_stream2_first);
	RCS(BSX.sat_stream1_count); RCS(BSX.sat_stream2_count);
	RCS(BSX.sat_stream1_queue); RCS(BSX.sat_stream2_queue);
	return n;
}
#endif

#undef RCS
#undef RCS_ARR

#endif
