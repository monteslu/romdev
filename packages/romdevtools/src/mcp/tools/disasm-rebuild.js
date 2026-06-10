// Rebuild planning for `disasm({target:'project'})`.
//
// `disasm({target:'project'})` splits a ROM into byte-exact `.asm` region files.
// But region files alone don't REBUILD the ROM — every console also needs its
// own "rebuild glue": the cartridge header (iNES for NES, the in-image $100
// header for Genesis, the LNX header for Lynx, the "AB" header for MSX…), any
// non-code DATA blobs (NES CHR-ROM), and a recipe that reassembles + concatenates
// everything back into a byte-identical image.
//
// This module turns a disassembled project into a TURNKEY one: for each platform
// it returns the extra data blobs to write plus the recipe that reproduces the
// original ROM. `disassembleProjectCore` writes the blobs, a machine-readable
// `rebuild.json` (when there's a one-call build() recipe), and a human/agent
// readable `BUILD.md`.
//
// Contract — planRebuild(platform, data, regions) returns:
//   {
//     blobs:      { [filename]: Uint8Array },   // extra files to write (CHR, headers)
//     build:      { ... } | null,               // the build({...}) args that reproduce
//                                                //   the ROM, or null if no one-call
//                                                //   build() route exists (see below)
//     verifiable: boolean,                       // true = the recipe (build() OR the
//                                                //   native recipe in `notes`) is proven
//                                                //   to reproduce the ROM byte-identically
//     notes:      string,                        // what the rebuilder must know
//   }
//
// `build.sourcesPaths` / `build.binaryIncludePaths` use BARE filenames (relative
// to the project dir); the emitter rewrites them to absolute paths in rebuild.json
// and BUILD.md. `build.linkerConfig`, when present, is INLINE .cfg text (not a
// path) — the emitter does not rewrite it.
//
// IMPORTANT — why most platforms have `build: null`:
//   `disasm` emits each region in the syntax of the NATIVE reassembler for that
//   CPU family (ca65 for 6502/65816; GNU `as` for z80/sm83/m68k/arm), which is
//   what round-trips it byte-exact. But `build()`'s shipping toolchains differ:
//   NES=cc65 (ca65 — MATCHES, so NES is a one-call build() rebuild), but
//   SNES=asar, Atari2600=dasm, SMS/GG/MSX/GB/GBC=SDCC, Genesis=vasm/SGDK,
//   GBA=arm-gcc(C-only) — none of which consume the disasm's syntax. For those,
//   the byte-exact rebuild is the NATIVE recipe documented in `notes` (and the
//   blobs are still written), so the project is rebuildable even though there's
//   no single build() call. `verifiable` reflects whether that recipe is proven
//   byte-identical, regardless of build()-vs-native.

/**
 * @param {string} platform
 * @param {Uint8Array} data       full ROM bytes
 * @param {Array<{name:string,file:string,kind?:string,fileOffset:number,bytes:Uint8Array,startAddress:number}>} regions
 * @returns {{ blobs: Record<string, Uint8Array>, build: object|null, verifiable: boolean, notes: string }}
 */
export function planRebuild(platform, data, regions) {
  const fn = PLANNERS[platform];
  if (fn) return fn(data, regions);
  return {
    blobs: {},
    build: regions.length ? { output: "rom", platform, sourcesPaths: srcMap(regions) } : null,
    verifiable: false,
    notes:
      `No platform-specific rebuild recipe for '${platform}' yet — the .asm region(s) ` +
      `reassemble, but you may need a linker config to concatenate them + re-add any ` +
      `cartridge header. See the platform's MENTAL_MODEL.md.`,
  };
}

/** {regionFile: regionFile} for sourcesPaths (bare names; emitter absolutizes). */
function srcMap(regions) {
  const m = {};
  for (const r of regions) m[r.file] = r.file;
  return m;
}

/** UTF-8 encode a synthesized text source so it can ship as a blob. */
function enc(s) {
  return new TextEncoder().encode(s);
}

/** The size + repeated byte of a region's stripped trailing pad, if uniform. */
function trailingPad(data, tailStart) {
  const count = data.length - tailStart;
  if (count <= 0) return { count: 0, byte: 0x00, uniform: true };
  const byte = data[tailStart];
  for (let i = tailStart + 1; i < data.length; i++) {
    if (data[i] !== byte) return { count, byte, uniform: false };
  }
  return { count, byte, uniform: true };
}

const PLANNERS = {
  // ───────────────────────────────────────────── NES (iNES + CHR-ROM)
  // The ONE platform with a one-call build() rebuild: disasm emits ca65, and the
  // NES build() toolchain IS cc65/ca65. inesHeader synthesizes the 16B header +
  // the CHARS segment wiring + the flat NROM .cfg. PROVEN byte-identical.
  nes(data, regions) {
    const prgBanks = data[4];
    const chrBanks = data[5];
    const mapper = (data[6] >> 4) | (data[7] & 0xf0);
    const mirroring = data[6] & 1 ? "vertical" : "horizontal";
    const battery = !!(data[6] & 2);
    const prgEnd = 16 + prgBanks * 0x4000;
    const blobs = {};
    const binaryIncludePaths = {};
    if (chrBanks > 0) {
      blobs["chr.bin"] = data.slice(prgEnd, prgEnd + chrBanks * 0x2000);
      binaryIncludePaths["chr.bin"] = "chr.bin";
    }
    const flat = mapper === 0 && prgBanks <= 2;
    if (flat) {
      // NROM: the inesHeader one-call path (PROVEN byte-identical). Unchanged.
      return {
        blobs,
        build: {
          output: "rom",
          platform: "nes",
          sourcesPaths: { "prg.asm": "bank0.asm" },
          ...(Object.keys(binaryIncludePaths).length ? { binaryIncludePaths } : {}),
          inesHeader: {
            prgBanks,
            ...(chrBanks ? { chrBanks } : {}),
            mirroring,
            ...(battery ? { battery: true } : {}),
          },
        },
        verifiable: true,
        notes: `NROM rebuild: inesHeader auto-emits the 16B header + wires chr.bin into the ` +
          `CHARS segment; bank0.asm is the PRG. One-call build() rebuild, byte-identical.`,
      };
    }
    // BANKED mapper (>0 or >2 PRG banks): emit COMPLETE working glue — the old
    // recipe pointed at bank0 only with the flat NROM cfg, which cannot rebuild
    // a banked ROM and cost a real RE session an hour of hand-written segments
    // + cfg (0.27.0 feedback #1). Components:
    //   nes_header.asm    — HEADER segment with the ORIGINAL 16 iNES bytes
    //   bankN_seg.asm     — `.segment "PRGn"` wrapper that includes bankN.asm
    //   nes_chars.asm     — CHARS segment .incbin of chr.bin (when CHR-ROM)
    //   nes_rebuild.cfg   — HEADER + one 16KB area per bank (+ CHR), in file order
    // and a rebuild.json build() call wired to ALL of it (linkerConfigPath keeps
    // the cfg out of context).
    const hdrBytes = Array.from(data.slice(0, 16))
      .map((b) => "$" + b.toString(16).toUpperCase().padStart(2, "0")).join(", ");
    blobs["nes_header.asm"] = enc(
      `; iNES header — the ORIGINAL 16 bytes, for a byte-exact rebuild.\n` +
      `.segment "HEADER"\n        .byte ${hdrBytes}\n`
    );
    const nBanks = regions.length;
    const memLines = [
      `    HEADER: start = $0000, size = $0010, type = ro, file = %O, fill = yes;`,
    ];
    const segLines = [
      `    HEADER: load = HEADER, type = ro;`,
    ];
    const sourcesPaths = { "nes_header.s": "nes_header.asm" };
    const includePaths = {};
    for (let i = 0; i < nBanks; i++) {
      const reg = regions[i];
      blobs[`bank${i}_seg.asm`] = enc(
        `; PRG bank ${i} wrapper (${reg.label}) — auto-generated by disasm({target:'project'}).\n` +
        `.segment "PRG${i}"\n.include "bank${i}.asm"\n`
      );
      memLines.push(`    PRG${i}: start = $${reg.startAddress.toString(16).toUpperCase()}, size = $4000, type = ro, file = %O, fill = yes, fillval = $FF;`);
      segLines.push(`    PRG${i}: load = PRG${i}, type = ro;`);
      sourcesPaths[`bank${i}_seg.s`] = `bank${i}_seg.asm`;
      includePaths[`bank${i}.asm`] = `bank${i}.asm`;
    }
    if (chrBanks > 0) {
      blobs["nes_chars.asm"] = enc(`; CHR-ROM data.\n.segment "CHARS"\n        .incbin "chr.bin"\n`);
      memLines.push(`    CHR: start = $0000, size = $${(chrBanks * 0x2000).toString(16).toUpperCase()}, type = ro, file = %O, fill = yes;`);
      segLines.push(`    CHARS: load = CHR, type = ro;`);
      sourcesPaths["nes_chars.s"] = "nes_chars.asm";
    }
    blobs["nes_rebuild.cfg"] = enc(
      `# Banked NES rebuild .cfg — auto-generated by disasm({target:'project'}).\n` +
      `# mapper ${mapper}, ${nBanks} x 16KB PRG banks (last bank at $C000)${chrBanks ? ", " + chrBanks + " x 8KB CHR" : ""}.\n` +
      `# MEMORY order = file order: header, banks 0..${nBanks - 1}${chrBanks ? ", CHR" : ""}.\n` +
      "MEMORY {\n" + memLines.join("\n") + "\n}\n" +
      "SEGMENTS {\n" + segLines.join("\n") + "\n}\n"
    );
    return {
      blobs,
      build: {
        output: "rom",
        platform: "nes",
        sourcesPaths,
        includePaths,
        ...(Object.keys(binaryIncludePaths).length ? { binaryIncludePaths } : {}),
        linkerConfigPath: "nes_rebuild.cfg",
      },
      verifiable: true,
      notes:
        `Banked NES (mapper ${mapper}, ${nBanks} x 16KB PRG): per-bank PRGn segment wrappers + ` +
        `nes_header.asm (original 16 bytes) + nes_rebuild.cfg are all emitted and wired into ` +
        `rebuild.json — a one-call byte-exact build() rebuild (linkerConfigPath keeps the cfg ` +
        `out of context). Switchable banks land at $8000, the fixed top bank at $C000.`,
    };
  },

  // ───────────────────────────────────────────── C64 (PRG: 2-byte load addr + body)
  // build({platform:'c64'}) IS cc65/ca65 (matches the disasm syntax), so this is
  // a one-call build() rebuild. planRegions strips the 2-byte load address
  // (fileOffset 2); we re-emit it via a synthesized LOADADDR segment + a custom
  // 2-area .cfg (LOADADDR then the body). PROVEN byte-identical via build().
  c64(data, _regions) {
    const loadAddr = data[0] | (data[1] << 8);
    const bodyLen = data.length - 2;
    const loadaddrSrc =
      "; C64 PRG load-address word — auto-generated by disasm({target:'project'}).\n" +
      '.setcpu "6502"\n' +
      '.segment "LOADADDR"\n' +
      `        .word $${loadAddr.toString(16).toUpperCase().padStart(4, "0")}   ; .prg load address\n`;
    const cfg =
      "# C64 .prg rebuild .cfg — auto-generated by disasm({target:'project'}).\n" +
      "# LOADADDR(2 B little-endian) + MAIN(program image), concatenated into one .prg.\n" +
      "MEMORY {\n" +
      `    LOADADDR: start = $${(loadAddr - 2).toString(16).toUpperCase()}, size = $0002, type = ro, file = %O, fill = yes;\n` +
      `    MAIN:     start = $${loadAddr.toString(16).toUpperCase()}, size = $${bodyLen.toString(16).toUpperCase()}, type = ro, file = %O, fill = yes, fillval = $FF;\n` +
      "}\n" +
      "SEGMENTS {\n" +
      "    LOADADDR: load = LOADADDR, type = ro;\n" +
      "    CODE:     load = MAIN,     type = ro;\n" +
      "}\n";
    return {
      blobs: { "loadaddr.asm": enc(loadaddrSrc) },
      build: {
        output: "rom",
        platform: "c64",
        language: "asm",
        sourcesPaths: { "loadaddr.asm": "loadaddr.asm", "prg.asm": "prg.asm" },
        linkerConfig: cfg,
      },
      verifiable: true,
      notes:
        `C64 .prg rebuild: the 2-byte load address ($${loadAddr.toString(16).toUpperCase()}) is re-emitted by the ` +
        `synthesized loadaddr.asm (LOADADDR segment); prg.asm carries the program image. The ` +
        `custom .cfg concatenates LOADADDR(2 B) + CODE(${bodyLen} B). One-call build() rebuild, ` +
        `byte-identical.`,
    };
  },

  // ───────────────────────────────────────────── Atari 7800 (.a78: header IN the region)
  // build({platform:'atari7800'}) IS cc65/ca65, and planRegions keeps the 128-byte
  // .a78 header inside rom.asm — so a single flat cc65 build reproduces the whole
  // .a78. One-call build() rebuild, PROVEN byte-identical.
  atari7800(data) {
    const org = (0x10000 - data.length) & 0xffff;
    const cfg =
      "# Atari 7800 .a78 rebuild .cfg — auto-generated by disasm({target:'project'}).\n" +
      "# One flat CODE segment carrying the .a78 header + cart image (planRegions keeps\n" +
      "# the 128-byte header inside rom.asm).\n" +
      "MEMORY {\n" +
      `    M: start = $${org.toString(16).toUpperCase()}, size = $${data.length.toString(16).toUpperCase()}, type = ro, file = %O, fill = yes, fillval = $FF;\n` +
      "}\n" +
      "SEGMENTS {\n" +
      "    CODE: load = M, type = ro;\n" +
      "}\n";
    return {
      blobs: {},
      build: {
        output: "rom",
        platform: "atari7800",
        language: "asm",
        sourcesPaths: { "rom.asm": "rom.asm" },
        linkerConfig: cfg,
      },
      verifiable: true,
      notes:
        `Atari 7800 .a78 rebuild: planRegions keeps the 128-byte .a78 header inside rom.asm ` +
        `(org $${org.toString(16).toUpperCase()}), so this single flat cc65 build reproduces the whole .a78 ` +
        `(header + cart). One-call build() rebuild, byte-identical. (If planRegions ever ` +
        `strips the .a78 header, ship it as a blob + re-prepend instead.)`,
    };
  },

  // ───────────────────────────────────────────── Atari 2600 (flat, dasm — no build() route)
  // The 2600 disasm emits ca65 syntax, but build({platform:'atari2600'}) is DASM,
  // which can't consume ca65 (.setcpu etc.). So no one-call build() route. The
  // rebuild IS byte-exact via the native ca65/ld65 chain (a flat fill .cfg) — that
  // recipe is in notes. (cc65 handles 6502; ld65 links it byte-exact.)
  atari2600(data, regions) {
    const reg = regions[0];
    const cfg =
      "# Atari 2600 flat-cart rebuild .cfg — auto-generated by disasm({target:'project'}).\n" +
      "MEMORY {\n" +
      `    M: start = $${reg.startAddress.toString(16).toUpperCase()}, size = $${reg.bytes.length.toString(16).toUpperCase()}, type = ro, file = %O, fill = yes, fillval = $FF;\n` +
      "}\n" +
      "SEGMENTS {\n    CODE: load = M, type = ro;\n}\n";
    return {
      blobs: { "atari2600_rebuild.cfg": enc(cfg) },
      build: null,
      verifiable: true,
      notes:
        `Atari 2600 flat ${reg.bytes.length}-byte cart @ $${reg.startAddress.toString(16).toUpperCase()}. The disasm emits ca65 ` +
        `syntax, but build({platform:'atari2600'}) is DASM — it can't reassemble ca65. ` +
        `Rebuild with the bundled native ca65/ld65 (byte-identical proven):\n` +
        `  ca65 rom.asm -o rom.o && ld65 -C atari2600_rebuild.cfg -o game.bin rom.o\n` +
        `(atari2600_rebuild.cfg is shipped as a blob.)`,
    };
  },

  // ───────────────────────────────────────────── Atari Lynx (.lnx: 64-byte header stripped)
  // build({platform:'lynx'}) IS cc65/ca65 and reproduces the HEADERLESS cart image
  // byte-exact (one-call). The 64-byte LNX header is stripped by planRegions; we
  // ship it as a blob (lnx_header.bin) — but build() can't prepend it, so the full
  // .lnx needs a final `cat lnx_header.bin + image`. verifiable reflects the full
  // .lnx recipe (header blob + built image), which is byte-identical.
  lynx(data, regions) {
    const hasLnxHeader =
      data.length >= 64 && data[0] === 0x4c && data[1] === 0x59 && data[2] === 0x4e && data[3] === 0x58;
    const reg = regions[0];
    const bodyLen = reg.bytes.length;
    const org = reg.startAddress;
    const base = hasLnxHeader ? 64 : 0;
    const pad = trailingPad(data, base + bodyLen);
    const cfg =
      "# Atari Lynx headerless cart-image rebuild .cfg — auto-generated by disasm.\n" +
      "MEMORY {\n" +
      `    M: start = $${org.toString(16).toUpperCase()}, size = $${bodyLen.toString(16).toUpperCase()}, type = ro, file = %O, fill = yes, fillval = $FF;\n` +
      "}\n" +
      "SEGMENTS {\n    CODE: load = M, type = ro;\n}\n";
    const blobs = {};
    if (hasLnxHeader) blobs["lnx_header.bin"] = data.slice(0, 64);
    return {
      blobs,
      build: {
        output: "rom",
        platform: "lynx",
        language: "asm",
        sourcesPaths: { "cart.asm": "cart.asm" },
        linkerConfig: cfg,
      },
      verifiable: pad.uniform && pad.count === 0,
      notes: !pad.uniform
        ? `Lynx: disasm's trailing-pad trim dropped a non-uniform run; the cart image can't ` +
          `be reproduced byte-exact from cart.asm. Re-disassemble without trailing-pad trimming.`
        : pad.count > 0
          ? `Lynx: disasm trimmed ${pad.count} trailing 0x${pad.byte.toString(16).padStart(2, "0")} pad byte(s) — re-pad the ` +
            `built image to ${data.length - base} bytes, then prepend lnx_header.bin for the full .lnx.`
          : `Lynx .lnx rebuild: build() of cart.asm reproduces the HEADERLESS cart image ` +
            `byte-identical. build() can't prepend the 64-byte LNX header, so for the original ` +
            `.lnx, concatenate the shipped lnx_header.bin (exact original header) + the built ` +
            `image. The headerless image alone runs on cores that accept an unheadered Lynx ROM. ` +
            `(Load org $${org.toString(16).toUpperCase()} is the disasm's byte-exact assumption.)`,
    };
  },

  // ───────────────────────────────────────────── SNES (LoROM, ca65 — no build() route)
  // build({platform:'snes'}) is ASAR (or tcc816 for C), neither of which assembles
  // ca65. No one-call build() route. The rebuild IS byte-exact via native ca65/
  // ld65: each bankN.asm wrapped in its own segment + an N-area .cfg. Recipe in
  // notes; wrappers + .cfg shipped as blobs.
  snes(data, regions) {
    const hasHeader = data.length % 1024 === 512;
    const nBanks = regions.length;
    const blobs = {};
    if (hasHeader) blobs["copier_header.bin"] = data.slice(0, 512);
    const memLines = [];
    const segLines = [];
    for (let i = 0; i < nBanks; i++) {
      blobs[`bank${i}_seg.asm`] = enc(
        `; SNES LoROM bank ${i} wrapper — auto-generated by disasm({target:'project'}).\n` +
        `.segment "BANK${i}"\n.include "bank${i}.asm"\n`
      );
      memLines.push(`    BANK${i}: start = $8000, size = $8000, type = ro, file = %O, fill = yes, fillval = $FF;`);
      segLines.push(`    BANK${i}: load = BANK${i}, type = ro;`);
    }
    const cfg =
      "# SNES LoROM rebuild .cfg — auto-generated by disasm({target:'project'}).\n" +
      `# ${nBanks} x 32KB banks at $8000, concatenated in order into one .sfc.\n` +
      "MEMORY {\n" + memLines.join("\n") + "\n}\n" +
      "SEGMENTS {\n" + segLines.join("\n") + "\n}\n";
    blobs["snes_rebuild.cfg"] = enc(cfg);
    return {
      blobs,
      build: null,
      verifiable: true,
      notes:
        `SNES LoROM (${nBanks} x 32KB bank(s)${hasHeader ? ", 512-byte copier header stripped → copier_header.bin" : ""}). ` +
        `The disasm emits ca65/65816 syntax, but build({platform:'snes'}) is asar/tcc816 — no ` +
        `build() route. Rebuild with the bundled native ca65/ld65 (byte-identical proven): for ` +
        `each bank, ca65 --cpu 65816 -o bankN.o bankN_seg.asm; then ld65 -C snes_rebuild.cfg ` +
        `-o game.sfc bank0.o..bank${nBanks - 1}.o` +
        (hasHeader ? ` (prepend copier_header.bin for the .smc with its 512-byte header).` : `.`) +
        ` (Wrappers + snes_rebuild.cfg shipped as blobs.)`,
    };
  },

  // ───────────────────────────────────────────── PC Engine (HuCard — disasm region is LOSSY)
  // PCE is the one honestly-NOT-verifiable case: planRegions trims real trailing
  // $FF padding AND doesn't strip a 512-byte copier header, so the region is a
  // lossy view of the .pce. We still emit a best-effort build call; the note is
  // explicit that an exact rebuild needs a planRegions fix.
  pce(data, regions) {
    const reg = regions[0];
    const bodyLen = reg.bytes.length;
    const hasCopierHeader = data.length % 1024 === 512;
    const trimmedPad = data.length - (hasCopierHeader ? 512 : 0) - bodyLen;
    const cfg =
      "# PC Engine HuCard rebuild .cfg — auto-generated by disasm({target:'project'}).\n" +
      "# NOTE: see BUILD.md — the region is a LOSSY view of this .pce.\n" +
      "MEMORY {\n" +
      `    M: start = $${reg.startAddress.toString(16).toUpperCase()}, size = $${bodyLen.toString(16).toUpperCase()}, type = ro, file = %O, fill = yes, fillval = $FF;\n` +
      "}\n" +
      "SEGMENTS {\n    CODE: load = M, type = ro;\n}\n";
    return {
      blobs: { "pce_rebuild.cfg": enc(cfg) },
      build: null,
      verifiable: false,
      notes:
        `PC Engine: NOT byte-identical from this disassembly. The region (${bodyLen} B) is shorter ` +
        `than the original (${data.length} B): planRegions trimmed ${trimmedPad > 0 ? trimmedPad : 0} byte(s) of REAL ` +
        `HuCard $FF padding` +
        (hasCopierHeader ? `, AND a 512-byte copier header was not stripped (its bytes are the first bytes of rom.asm at a bogus org)` : ``) +
        `. To rebuild faithfully, re-disassemble after fixing planRegions to (a) strip a ` +
        `512-byte copier header when len%1024==512 and (b) not trailing-pad-trim HuCard images ` +
        `(or trim only to an 8KB-bank boundary). Also: the disasm emits ca65 but ` +
        `build({platform:'pce'}) is cc65 — the native ca65/ld65 chain with pce_rebuild.cfg is ` +
        `the rebuild path once the region is faithful.`,
    };
  },

  // ───────────────────────────────────────────── SMS / GG (flat Z80, no header)
  sms(data, regions) { return planSegaFlat("sms", data, regions); },
  gg(data, regions) { return planSegaFlat("gg", data, regions); },

  // ───────────────────────────────────────────── MSX ("AB" cart header + Z80)
  // build({platform:'msx'}) is SDCC (sdasz80) — can't reassemble the GNU-`as`
  // rom.asm the disasm emits. No build() route. The 16-byte "AB" header is
  // stripped by planRegions (region starts at $4010); shipped as msx_header.bin
  // + re-prepended. With the reassemble.js .org-floor fix, rom.asm now round-trips
  // (the region is at $4010), so the native recipe is byte-exact.
  msx(data, regions) {
    const reg = regions.find((r) => r.file === "rom.asm") ?? regions[0];
    const hasHeader = data.length >= 2 && data[0] === 0x41 && data[1] === 0x42; // "AB"
    const blobs = {};
    if (hasHeader) blobs["msx_header.bin"] = data.slice(0, 16);
    const bodyStart = hasHeader ? 16 : 0;
    const bodyLen = reg ? reg.bytes.length : data.length - bodyStart;
    const pad = trailingPad(data, bodyStart + bodyLen);
    return {
      blobs,
      build: null,
      verifiable: pad.uniform,
      notes:
        `MSX cartridge = 16-byte "AB" header at $4000 + Z80 image; the disasm strips the header ` +
        `(rom.asm starts at $4010)` +
        (hasHeader ? `. The 16 header bytes are shipped as msx_header.bin.` : ` (no "AB" header in this ROM).`) +
        ` build({platform:'msx'}) is SDCC — it can't reassemble the GNU-\`as\` rom.asm. Rebuild ` +
        `natively (bundled z80 binutils): z80-elf-as -march=z80 rom.asm -o rom.o; ` +
        `z80-elf-objcopy -O binary rom.o body.bin; take body.bin[0x4010 : 0x4010+${bodyLen}]; ` +
        `cat msx_header.bin + that body` +
        (pad.count > 0 ? `; pad with 0x${pad.byte.toString(16).padStart(2, "0")} up to ${data.length} bytes.` : `.`) +
        (pad.uniform ? ` Byte-identical (with the reassemble .org-floor fix).` : ` WARNING: trailing pad is non-uniform — capture the tail separately.`),
    };
  },

  // ───────────────────────────────────────────── Game Boy / GBC (sm83)
  gb(data, regions) { return planGb(data, regions); },
  gbc(data, regions) { return planGb(data, regions); },

  // ───────────────────────────────────────── Genesis / Mega Drive (m68k, flat)
  // build({platform:'genesis'}) is vasm68k (Motorola syntax) or SGDK C, and it
  // re-pads + rewrites the $18E checksum — no build() route. The header+vectors
  // ($000000..resetPC) are not in any region → shipped as header.bin + prepended;
  // trailing pad re-added. Native recipe byte-identical proven.
  genesis(data, regions) {
    const reg = regions.find((r) => r.file === "rom.asm") || regions[0];
    const start = reg.startAddress;
    const regionLen = reg.bytes.length;
    const header = data.slice(0, start);
    const pad = trailingPad(data, start + regionLen);
    return {
      blobs: { "header.bin": header },
      build: null,
      verifiable: pad.uniform,
      notes:
        `Genesis rebuild = header.bin (${header.length} B: 68k vectors + Sega header, up to the reset ` +
        `PC $${start.toString(16)}) + rom.asm region + ${pad.count} byte(s) of 0x${pad.byte.toString(16).padStart(2, "0")} trailing pad, ` +
        `concatenated in file order. build({platform:'genesis'}) is vasm68k/SGDK and rewrites the ` +
        `$18E checksum — no build() route. Rebuild natively: reassembleForPlatform({platform:'genesis', ` +
        `bytes:<rom.asm region bytes>, startAddress:0x${start.toString(16)}}) (or m68k-elf-as → ld → ` +
        `objcopy; the LINKED objcopy output starts at offset 0 — take bin.slice(0, ${regionLen})), then ` +
        `header.bin ++ region ++ pad. The $18E checksum is inside header.bin (re-added verbatim). ` +
        (pad.uniform ? `Byte-identical proven.` : `WARNING: trailing pad is non-uniform — capture the tail separately.`),
    };
  },

  // ───────────────────────────────────────────── Game Boy Advance (ARM7TDMI)
  // build({platform:'gba'}) is C-only (asm path not wired) — no build() route. The
  // 192-byte header is a data region; shipped as header.bin (blob) and prepended
  // verbatim (reproduces the 0xBD checksum, no recompute). code.asm reassembles
  // natively (Thumb-as-ARM falls to the byte-exact .byte floor). Native recipe
  // byte-identical proven.
  gba(data, regions) {
    const codeReg = regions.find((r) => r.file === "code.asm") || regions[regions.length - 1];
    const codeStart = codeReg.startAddress;
    const codeLen = codeReg.bytes.length;
    const header = data.slice(0, 0xc0);
    const pad = trailingPad(data, 0xc0 + codeLen);
    return {
      blobs: { "header.bin": header },
      build: null,
      verifiable: pad.uniform,
      notes:
        `GBA rebuild = header.bin (192 B) + code.asm region + ${pad.count} byte(s) of ` +
        `0x${pad.byte.toString(16).padStart(2, "0")} trailing pad, concatenated in file order. ` +
        `build({platform:'gba'}) is C-only (asm path not wired) — no build() route. Rebuild ` +
        `natively: reassembleForPlatform({platform:'gba', bytes:<code.asm region bytes>, ` +
        `startAddress:0x${codeStart.toString(16)}}) (or arm-none-eabi-as → ld → objcopy; take ` +
        `bin.slice(0, ${codeLen})), then header.bin ++ code ++ pad. Use header.bin (this blob) for the ` +
        `concat — the 0xBD header checksum is inside it (reproduced verbatim, no recompute). ` +
        (pad.uniform ? `Byte-identical proven.` : `WARNING: trailing pad is non-uniform — capture the tail separately.`),
    };
  },
};

/**
 * Shared SMS/GG flat-ROM planner. The region is the whole image at $0000 with a
 * uniform trailing pad stripped by trimTrailingPad — recover the cart size + pad
 * byte so the rebuilder re-pads exactly. build:null (SDCC can't reassemble the
 * GNU-`as` rom.asm); native recipe in notes, byte-identical proven.
 */
function planSegaFlat(platform, data, regions) {
  const reg = regions.find((r) => r.file === "rom.asm") ?? regions[0];
  const trimmedLen = reg ? reg.bytes.length : data.length;
  const pad = trailingPad(data, trimmedLen);
  const name = platform === "sms" ? "Master System" : "Game Gear";
  return {
    blobs: {},
    build: null,
    verifiable: pad.uniform,
    notes:
      `${name} ROM is a FLAT Z80 image at $0000 with no external cartridge header (the "TMR ` +
      `SEGA" signature at $7FF0 is in-image). disasm emits one rom.asm at $0000; trimTrailingPad ` +
      `stripped ${pad.count} trailing 0x${pad.byte.toString(16).padStart(2, "0")} byte(s) (uniform run; original cart ${data.length} B). ` +
      `build({platform:'${platform}'}) is SDCC — it can't reassemble the GNU-\`as\` rom.asm. Rebuild ` +
      `natively (bundled z80 binutils, byte-identical proven): z80-elf-as -march=z80 rom.asm -o ` +
      `rom.o; z80-elf-objcopy -O binary rom.o body.bin (region at $0000 — no lead-in to strip); ` +
      (pad.count > 0 ? `pad body.bin with 0x${pad.byte.toString(16).padStart(2, "0")} up to ${data.length} bytes.` : `that's the cart image.`) +
      (pad.uniform ? `` : ` WARNING: trailing pad is non-uniform — capture the tail separately.`),
  };
}

/**
 * Game Boy / GBC rebuild planner. Flat 16KB banks; header in-image at
 * $0104-$014F inside bank 0 (reproduced as `.byte` data — no patchGbHeader/rgbfix
 * needed). build({platform:'gb'}) is RGBDS/SDCC — can't reassemble the GNU-`as`
 * bankN.asm. Native recipe byte-identical proven (with the .org-floor fix that
 * makes bank1 @ $4000 round-trip).
 */
function planGb(data, regions) {
  const banks = regions.length;
  return {
    blobs: {},
    build: null,
    verifiable: true,
    notes:
      `Game Boy${banks > 1 ? ` (${banks} × 16KB banks)` : ""}: the disasm emits GNU-\`as\` (gbz80) syntax ` +
      `that build() can't reassemble — rgbasm rejects it and rgbfix would rewrite the checksums — so ` +
      `no build() route. The header ($0104-$014F incl. the $014D header + $014E-$014F global ` +
      `checksums) is \`.byte\` data in bank0.asm and reproduces exactly: do NOT run rgbfix; ` +
      `patchGbHeader is NOT needed. Rebuild natively (bundled binutils, byte-identical proven), ` +
      `assembling each bank and concatenating:\n` +
      regions
        .map(
          (r) =>
            `  z80-elf-as -march=gbz80 ${r.file} -o ${r.name}.o && z80-elf-objcopy -O binary ${r.name}.o ${r.name}.full && ` +
            `dd if=${r.name}.full of=${r.name}.bin bs=1 skip=$((0x${r.startAddress.toString(16)})) count=16384`
        )
        .join("\n") +
      `\n  cat ${regions.map((r) => r.name + ".bin").join(" ")} > rebuilt.gb`,
  };
}
