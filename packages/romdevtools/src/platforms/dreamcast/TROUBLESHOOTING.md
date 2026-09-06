# Sega Dreamcast — troubleshooting

Read `platform({op:'doc', platform:'dreamcast', name:'mental_model'})` first — DC runs
on Flycast (hardware GPU + reios HLE BIOS), with a working emulated-framebuffer path.

## "ROM/ELF builds but won't boot"

1. **reios HLE must be on.** Flycast only boots a raw homebrew ELF via the **reios HLE
   BIOS** (`flycast_hle_bios: enabled`) — it parses the ELF + jumps. With it off,
   Flycast wants a real `dc_boot.bin` you don't ship. romdev's DC core config already
   enables reios; if you swapped the core/config, re-enable it.
2. **You built a flat binary, not a KOS ELF.** Flycast loads the KallistiOS ELF
   (linked at `0x8C00_0000`). Use `build({platform:'dreamcast'})` — it links against
   KOS and emits the loadable image. A bare `.bin` with no ELF/entry won't boot.

## "Boots but the screen is BLACK"

1. **Nothing was drawn to the framebuffer OR submitted to the TA.** DC has two render
   routes (see mental model). For the simple path, write the DC framebuffer (the
   `flycast_emulate_framebuffer: enabled` path scans it out — a framebuffer-writing
   program shows pixels). For 3D, submit PowerVR2 **TA** lists via KOS. A blank screen
   = neither happened. Confirm with `frame({op:'verify'})` (nearlyBlank).
2. **No display/render init.** The PowerVR2 needs its video mode + render target set
   up (KOS `vid_set_mode` / `pvr_init`). Without it there's no scanout. Call the KOS
   init (or the helper lib's init) before drawing.
3. **You expected raw VRAM writes to a TA-only setup to show.** With the framebuffer-
   emulation path enabled they do; if you disabled it and use pure TA, only submitted
   TA geometry renders.

## "Geometry/3D is wrong or missing (TA path)"

PowerVR2 is a **tile-based DEFERRED** renderer — opaque, punch-through, and translucent
lists are submitted + sorted per tile. Submitting polys to the wrong list type, or not
finalizing the list, drops them. Use KOS's `pvr_*` list API (it orders this correctly)
rather than hand-encoding TA commands.

## "decompile: which address space?"

`disasm({target:'decompile'})` loads the image at its load address (the ELF
`PT_LOAD` vaddr, or 0x8C010000 for a flat binary) — `provenance.loadedAt`
and `analysisAddressSpace:"absolute"` say so — so absolute references resolve
during analysis. PC-relative loads (below) are a separate matter.

## "disasm/decompile returns junk addresses on a multi-function program"

SH-4 decompiles well, but it uses **PC-relative loads** (`mov.l @(disp,PC)`) heavily,
so the analysis buffer's flat offsets must line up with the binary's load VA or
constant/address resolution breaks. Build a **multi-function** test program to verify
`functions` returns real VAs that round-trip — a single-instruction smoke test hides
base-address misalignment. (Same class of trap as the PS1 rebase issue.)

## "breakpoint / watch return N/A"

`cpu({op:'read'})` and `audioDebug({op:'inspect', chip:'aica'})` ARE wired on DC (the
flycast core exports `romdev_sh4_regs_get` + `romdev_aica_get`). `breakpoint`/`watch`
are not yet — those need interpreter-step + memory-path hooks in flycast (cpuState/
audioDebug are plain register reads). Use `cpu`/`audioDebug` + `memory` +
`disasm`/`decompile` meanwhile.

## "renderingContext returns N/A"

Correct — DC is a 3D TA machine with no 2D tile/sprite VDP for that op. Not a bug.
