// platform.js — what the matching loop needs to know per splat platform, in
// ONE place: endianness (how ROM/rodata words are read), the assembler flags
// for the target object, the binutils prefixes to look for, the ROM header
// reader, and how a captured compile invocation maps to a compiler kind, an
// m2c target and a decomp-permuter compiler_type.
//
// n64 is the proven profile (Wave Race 64, IDO 5.3). psx/psp/ps2 are the
// other splat layouts: the code paths are the same MIPS ones, parameterized
// here, but no PS1 checkout has been run through them yet — the capability
// manifest says so and `import` marks such a project `platformVerified:false`.
import path from "node:path";

export const PROFILES = {
  n64: {
    platform: "n64", endian: "big", wordSize: 4,
    asFlags: ["-march=vr4300", "-32", "-G0", "-EB"],
    binutilsPrefixes: ["mips-linux-gnu-", "mips64-linux-gnu-", "mips64-elf-"],
    romExtensions: [".z64", ".n64", ".v64"],
    m2cTargetByCompiler: { ido: "mips-ido-c", gcc: "mips-gcc-c" },
    permuterTypeByCompiler: { ido: "ido", gcc: "gcc" },
    exceptionVector: [0x80000000, 0x80000400],
    ramWordSwap: true, // RDRAM is exposed as little-endian 32-bit words; ROM is big-endian
    verified: true,
  },
  psx: {
    platform: "ps1", endian: "little", wordSize: 4,
    asFlags: ["-march=r3000", "-mtune=r3000", "-32", "-G0", "-EL"],
    binutilsPrefixes: ["mipsel-linux-gnu-", "mips-linux-gnu-", "mipsel-none-elf-"],
    romExtensions: [".exe", ".bin", ".psx"],
    m2cTargetByCompiler: { gcc: "mips-gcc-c", ido: "mips-ido-c" },
    permuterTypeByCompiler: { gcc: "gcc", ido: "ido" },
    exceptionVector: [0x80000000, 0x80000100], // 0x80000080 general vector
    ramWordSwap: false,
    verified: false,
  },
  psp: {
    platform: "psp", endian: "little", wordSize: 4,
    asFlags: ["-march=allegrex", "-32", "-G0", "-EL"],
    binutilsPrefixes: ["psp-", "mipsel-linux-gnu-"],
    romExtensions: [".prx", ".elf", ".bin"],
    m2cTargetByCompiler: { gcc: "mips-gcc-c" },
    permuterTypeByCompiler: { gcc: "gcc" },
    exceptionVector: [0, 0], ramWordSwap: false, verified: false,
  },
  ps2: {
    platform: "ps2", endian: "little", wordSize: 4,
    asFlags: ["-march=r5900", "-mabi=eabi", "-G0", "-EL"],
    binutilsPrefixes: ["ee-", "mips64r5900el-ps2-elf-", "mipsel-linux-gnu-"],
    romExtensions: [".elf", ".bin"],
    m2cTargetByCompiler: { gcc: "mipsee-gcc-c" },
    permuterTypeByCompiler: { gcc: "gcc" },
    exceptionVector: [0, 0], ramWordSwap: false, verified: false,
  },
};

/** Profile for a splat `options.platform` (n64/psx/psp/ps2) or a romdev platform id (n64/ps1). */
export function profileFor(platform) {
  const key = platform === "ps1" ? "psx" : platform;
  const p = PROFILES[key];
  if (!p) throw Object.assign(new Error(`no decomp platform profile for '${platform}' (known: ${Object.keys(PROFILES).join(", ")})`), { code: "UNSUPPORTED_PLATFORM" });
  return p;
}

/** Read a 32-bit word from a buffer in the profile's byte order. */
export function readWord(profile, buf, off) {
  return profile.endian === "big" ? buf.readUInt32BE(off) : buf.readUInt32LE(off);
}

/** N64 ROM header (any byte order); other platforms return what can be read cheaply. */
export function readRomHeader(profile, buf) {
  if (profile.platform === "n64") {
    const magic = buf.subarray(0, 4).toString("hex");
    const byteOrder = magic === "80371240" ? "z64 (big-endian, native)" : magic === "37804012" ? "v64 (byte-swapped)" : magic === "40123780" ? "n64 (little-endian)" : `unknown magic ${magic}`;
    const header = magic === "80371240" ? { entry: "0x" + buf.readUInt32BE(8).toString(16).toUpperCase().padStart(8, "0"), name: buf.subarray(0x20, 0x34).toString("latin1").trim(), cartId: buf.subarray(0x3b, 0x3e).toString("latin1"), region: String.fromCharCode(buf[0x3e]), version: buf[0x3f] } : null;
    return { byteOrder, header };
  }
  if (profile.platform === "ps1" && buf.length >= 0x800 && buf.subarray(0, 8).toString("latin1") === "PS-X EXE") {
    return { byteOrder: "PS-EXE (little-endian)", header: { pc0: "0x" + buf.readUInt32LE(0x10).toString(16), tAddr: "0x" + buf.readUInt32LE(0x18).toString(16), tSize: buf.readUInt32LE(0x1c), region: buf.subarray(0x4c, 0x4c + 40).toString("latin1").replace(/\0.*$/, "").trim() } };
  }
  return { byteOrder: profile.endian === "big" ? "big-endian" : "little-endian", header: null };
}

/**
 * Classify a captured compile argv: the compiler kind (ido/gcc/unknown), the
 * compiler executable, and the assembler it drives (asm-processor form
 * `python build.py <flags> <cc> -- <as> <asflags> -- <ccargs>` or a plain
 * `<cc> <args>` form).
 */
export function classifyInvocation(argv) {
  if (!argv?.length) return { kind: "unknown", compiler: null, assembler: null, ccArgv: [] };
  const bp = argv.findIndex((a) => /asm-processor\/build\.py$/.test(a));
  let compiler, assembler = null, ccArgv;
  if (bp >= 0) {
    const first = argv.indexOf("--"), second = argv.indexOf("--", first + 1);
    compiler = argv[first - 1]; assembler = argv[first + 1] ?? null; ccArgv = [compiler, ...argv.slice(second + 1)];
  } else { compiler = argv[0]; ccArgv = argv; }
  const kind = /ido|\/cc$|\bcc\b.*ido/i.test(compiler) && !/gcc/.test(compiler) ? "ido" : /gcc|cc1|g\+\+/.test(compiler) ? "gcc" : "unknown";
  return { kind, compiler, assembler, ccArgv };
}

/** Which binutils prefix is available for this project (from the captured assembler, else by probing PATH). */
export function binutilsPrefixFromAssembler(assembler) {
  if (!assembler) return null;
  const base = path.basename(assembler);
  const m = /^(.*-)as$/.exec(base);
  return m ? m[1] : null;
}
