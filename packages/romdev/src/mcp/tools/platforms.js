import { CORES, listAvailableCores, resolveCore } from "../../cores/registry.js";
import { TOOLCHAINS } from "../../toolchains/registry.js";
import { getLanguageOptions } from "../../toolchains/index.js";
import { jsonContent, safeTool } from "../util.js";

// Per-platform quirks the agent should know up front. Surfaced via
// listPlatforms so they don't have to re-discover via failed builds.
const PLATFORM_QUIRKS = {
  snes: {
    multiBank: true,
    maxRomBytesPerBank: 32768,
    headerLocation: "$XXFFC0..$XXFFFF in bank $00 only",
    notes: [
      "asar 1.x silently crashes if `org` rewinds to a lower bank — keep org directives in monotonically increasing bank order.",
      "LoROM header at $00FFC0 must be written BEFORE any large incbin that would extend past it. See lorom_multibank.asm starter snippet.",
      "Bank $00 has only ~32 KB before the header at $FFC0. Put CHR/audio/level data in bank $01+ (org $018000).",
      "SPC700 audio chip is separate from main 65816 CPU — upload driver via IPL handshake, communicate via $2140-$2143 mailbox ports. See audio_pipeline.asm.",
      "DSP register $5C is KOFF, $6C is FLG. Many references swap them. Power-on FLG=$E0 (mute+reset). Confirmed by 4hr debugging.",
      "Debugging tools available: getCPUState({cpu:'main'|'spc700'}), getAudioState({chip:'dsp'}), inspectSprites, inspectPalette, readMemory regions snes_oam/snes_cgram/snes_aram/snes_fillram.",
    ],
    starterSnippets: ["lorom_header.asm", "lorom_multibank.asm", "reset_init.asm", "nmi_safe.asm", "oam_upload.asm", "cgram_upload.asm", "vram_dma_upload.asm", "pad_read.asm", "sprite_table_populate.asm", "audio_pipeline.asm"],
  },
  genesis: {
    multiBank: false,                    // Genesis ROMs are flat 4MB max without mappers
    maxRomBytesPerBank: 4 * 1024 * 1024,
    headerLocation: "$00000100..$000001FF (256-byte ROM header after vector table at $00..$FF)",
    notes: [
      "68000 reads SSP from $00000000 and reset PC from $00000004 on power-on. Vector table fills $00-$FF (64 vectors × 4 bytes). See header.s starter snippet.",
      "ROM header at $100 must include 'SEGA MEGA DRIVE ' magic for real hardware to boot. Emulators (gpgx) tolerate its absence; cartridges don't.",
      "Z80 sound CPU is separate — sits at $A00000, has its own 8KB RAM. Bus protocol: request via $A11100, wait for grant, write code, release reset via $A11200, release bus. See z80_bootstrap.s.",
      "YM2612 FM synth + SN76489 PSG are accessed via $A04000-$A04003 and $C00011 respectively. Most games drive them from the Z80 via SMPS or similar driver.",
      "VDP at $C00000 (data) + $C00004 (control). 24 registers control video — vdp_init.s shows the standard 320×224 H40 setup.",
      "VDP DMA during ACTIVE display causes 'snow' artifacts. Only DMA during VBlank or HBlank windows. See sprite_table.s for the DMA sprite-table upload pattern.",
      "Genesis sprites use a LINKED LIST: each sprite has a link byte pointing to the next. Link 0 = end of list. Must initialize sprite 0's link even if you have just one sprite.",
      "Debugging tools available: getCPUState({cpu:'main'}) for 68K, inspectSprites, inspectPalette, getAudioState({chip:'ym2612'|'psg'}), readMemory regions genesis_cram/genesis_vsram/genesis_vdp_regs/genesis_z80_ram/genesis_m68k.",
    ],
    starterSnippets: ["header.s", "vdp_init.s", "sprite_table.s", "nmi_safe.s", "z80_bootstrap.s"],
  },
};

export function registerPlatformTools(server, z) {
  server.tool(
    "listPlatforms",
    "List every retro platform rom-dev-mcp can run. For each platform: emulator core, toolchain(s), the available programming languages (with the documented default), and any platform-specific quirks. Use this first to discover what's possible — and to check whether a non-default language is available before asking buildSource for it.",
    {},
    safeTool(async () => {
      const available = new Set(listAvailableCores());
      const platforms = Object.entries(CORES).map(([id, info]) => {
        const toolchains = Object.values(TOOLCHAINS)
          .filter((t) => t.platforms.includes(id))
          .map((t) => ({ id: t.id, displayName: t.displayName, tier: t.tier }));
        const entry = {
          platform: id,
          displayName: info.displayName,
          coreName: info.coreName,
          coreAvailable: available.has(id),
          toolchains,
        };
        // Surface the language matrix: defaultLanguage + per-language
        // {toolchain, available, note}. Lets agents see "I can ask for C
        // on Genesis but the SGDK toolchain isn't bundled yet" without
        // trial-and-error. Defaults are chosen for vibe-coding (smallest
        // toolchain, fastest build, best LLM fluency) — picky users
        // override via the `language` parameter on buildSource.
        const langs = getLanguageOptions(id);
        if (langs) entry.languages = langs;
        if (PLATFORM_QUIRKS[id]) entry.quirks = PLATFORM_QUIRKS[id];
        return entry;
      });
      return jsonContent({ platforms });
    }),
  );

  server.tool(
    "resolvePlatform",
    "Return the resolved core paths for a platform (debugging aid).",
    {
      platform: z.string().describe("Platform id (e.g. 'nes', 'gb', 'genesis')."),
    },
    safeTool(async ({ platform }) => {
      const r = resolveCore(platform);
      if (!r) throw new Error(`no core available for platform '${platform}'`);
      return jsonContent(r);
    }),
  );
}
