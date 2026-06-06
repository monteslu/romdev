import { CORES, listAvailableCores, resolveCore } from "../../cores/registry.js";
import { TOOLCHAINS } from "../../toolchains/registry.js";
import { getLanguageOptions } from "../../toolchains/index.js";
import { jsonContent, safeTool } from "../util.js";
import { listToolchainsCore, installToolchainCore } from "./toolchain.js";
import { listPlatformDocsCore, getPlatformDocCore } from "./platform-docs.js";

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
  pce: {
    multiBank: false,                    // HuCard up to 1MB flat (no mapper for the common case)
    maxRomBytesPerBank: 8 * 1024 * 1024,
    headerLocation: "none — PCE HuCards boot from the reset vector at $FFFE (no magic header)",
    notes: [
      "Toolchain is cc65 (HuC6280 = 65C02 superset), language C by default. The conio text library is the fastest path to a visible screen — it inits the HuC6270 VDC + HuC6260 VCE and uploads a font for you.",
      "EMPTY-BSS TRAP: cc65's pce/crt0.s clears .bss with `tii ...,__BSS_SIZE__-1`. With NO globals, __BSS_SIZE__=0 → ld65 'Range error in pce/crt0.s' AND a BLACK screen. ALWAYS keep at least one (ideally 2+ byte) global/static. See the hello_pce.c starter's `_keep_bss`.",
      "Color is the HuC6260 VCE: 512 entries (256 BG + 256 SPR), 9-bit GRB (0bGGG_RRR_BBB). inspectPalette decodes it; area:'bg'|'sprite' narrows. Slot 0 of each 16-color sub-palette = transparent.",
      "Sprites are the HuC6270 SATB: 64 sprites, 16/32 wide × 16/32/64 tall, pattern codes index 16×16 cells in VRAM. inspectSprites reads it.",
      "Debugging: getCPUState (huc6280), inspectPalette, inspectSprites, getRenderingContext (VDC R5 screen-enable + scroll), getAudioState({chip:'pce'}) (6-channel PSG), getMemoryMap, readMemory regions pce_vdc_vram/pce_vdc_satb/pce_vdc_regs/pce_vce_palette/pce_cpu_regs/pce_psg_regs.",
    ],
    starterSnippets: ["hello_pce.c"],
  },
  msx: {
    multiBank: false,                    // plain 32KB cartridge ($4000-$BFFF); mappers exist but not for the starter
    maxRomBytesPerBank: 32 * 1024,
    headerLocation: "$4000: 'AB' magic + INIT pointer at $4002 (the BIOS CALLs INIT to start the cart)",
    notes: [
      "Toolchain is SDCC (z80), language C by default. A cart maps at $4000-$BFFF; build with the msx_crt0.s starter (emits the 'AB' header) + `crt0:'.module empty\\n'`. romdev ships C-BIOS (open MSX BIOS) and auto-boots the MSX2+ machine — no proprietary ROM, zero setup.",
      "INIT MUST NOT RETURN: C-BIOS CALLs the cart INIT to hand over the machine. If it `ret`s, the BIOS prints 'No cartridge found' (after running your code). End main() in an infinite loop — see hello_msx.c.",
      "TIMING: C-BIOS shows its logo for ~2-3s (≈150 frames) BEFORE calling the cart INIT. Step >= 240 frames before expecting output on screen.",
      "Fastest visible output is BIOS calls: INITXT ($006C) sets the 40-col text screen + enables display, CHPUT ($00A2) prints the char in A. Put asm data labels INSIDE a function's asm block (file-scope __asm is a SDCC syntax error).",
      "Video is the V9938 VDP: VRAM up to 128KB, 16-entry programmable palette (9-bit GRB) on MSX2 bitmap modes, fixed TMS9918 palette on MSX1 modes. inspectPalette picks the right source automatically.",
      "Debugging: getCPUState (z80), inspectPalette, inspectSprites (VRAM sprite-attr table), getRenderingContext (VDP R1 screen-enable + mode + VRAM table bases), getAudioState({chip:'ay8910'}) (3 square + noise + envelope), getMemoryMap (pass the sdld .map), readMemory regions msx_vram/msx_vdp_regs/msx_vdp_status/msx_palette/msx_cpu_regs/msx_psg_regs.",
    ],
    starterSnippets: ["hello_msx.c", "msx_crt0.s"],
  },
};

/** op:'list' — every platform with core/toolchains/languages/quirks. */
export function listPlatformsCore() {
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
        const langs = getLanguageOptions(id);
        if (langs) entry.languages = langs;
        if (PLATFORM_QUIRKS[id]) entry.quirks = PLATFORM_QUIRKS[id];
        return entry;
      });
      return { platforms };
}

/** op:'resolve' — resolved core paths for a platform (debugging aid). */
export function resolvePlatformCore({ platform }) {
      const r = resolveCore(platform);
      if (!r) throw new Error(`no core available for platform '${platform}'`);
      return r;
}

export function registerPlatformTools(server, z) {
  server.tool(
    "platform",
    "Platform/toolchain/docs discovery — what romdev can run and how. `op`: 'list' | 'resolve' | 'toolchains' | " +
    "'docs' | 'doc'.\n" +
    "'list': every platform with its emulator core, toolchain(s), available languages (+ documented default), and " +
    "platform-specific quirks. Call this FIRST to discover what's possible + check a non-default language is " +
    "available before asking build for it.\n" +
    "'resolve': resolved core paths for a platform (debugging aid).\n" +
    "'toolchains': the bundled homebrew toolchains (all Tier-1 = bundled WASM, no install). Pass `id` to confirm a " +
    "specific toolchain's install status (a no-op in v1 — everything's bundled).\n" +
    "'docs': the doc names available for a platform. 'doc': the full markdown of one (`name`: mental_model / " +
    "troubleshooting / upstream_sources; `platform:'romhacking'` + `name:'playbook'` for the RE decision tree). " +
    "Read MENTAL_MODEL before writing code, and the romhacking playbook before a hack.",
    {
      op: z.enum(["list", "resolve", "toolchains", "docs", "doc"]).describe("list=platforms; resolve=core paths; toolchains; docs=a platform's doc names; doc=read one doc."),
      platform: z.string().optional().describe("op=resolve/docs/doc: platform id (e.g. nes, gb, genesis; 'romhacking' for the RE playbook)."),
      id: z.string().optional().describe("op=toolchains: a specific toolchain's install status (e.g. 'cc65')."),
      name: z.string().optional().describe("op=doc: which doc — mental_model | troubleshooting | upstream_sources | playbook."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "list":    return jsonContent(listPlatformsCore());
        case "resolve": {
          if (!args.platform) throw new Error("platform({op:'resolve'}): `platform` is required.");
          return jsonContent(resolvePlatformCore(args));
        }
        case "toolchains": return jsonContent(args.id ? installToolchainCore(args) : listToolchainsCore());
        case "docs": {
          if (!args.platform) throw new Error("platform({op:'docs'}): `platform` is required.");
          return jsonContent(await listPlatformDocsCore(args));
        }
        case "doc": {
          if (!args.platform || !args.name) throw new Error("platform({op:'doc'}): `platform` and `name` are required.");
          return await getPlatformDocCore(args);
        }
        default: throw new Error(`platform: unknown op '${args.op}'`);
      }
    }),
  );
}
