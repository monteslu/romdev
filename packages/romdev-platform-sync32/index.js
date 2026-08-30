// romdev-platform-sync32 — the sync32 SDK tree (crt0, linker scripts, header).
//
// A sync32 cart is a freestanding Cortex-M33 binary, so building one needs
// three things from the SDK beyond the C source: the crt0 that provides the
// vector table and `_start`, the linker script that places the image at the
// mode's base address, and sync32.h for the console API. They are small and
// text-only, so they ship here rather than requiring a sibling checkout.
//
// The COMPILER is not here: sync32 builds reuse the WASM arm-none-eabi
// toolchain in romdev-platform-gba (same gcc, different -mcpu), which is why
// this package is a few KB rather than 155MB.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARE = path.join(__dirname, "share", "sync32");

export const platform = "sync32";
export const shareDir = SHARE;

/** Absolute paths to the SDK assets a cart build needs. */
export const sdk = {
  crt0: path.join(SHARE, "crt0", "crt0.S"),
  linkScripts: {
    ram: path.join(SHARE, "crt0", "ram.ld"),
    xip: path.join(SHARE, "crt0", "xip.ld"),
  },
  headers: {
    "sync32.h": path.join(SHARE, "include", "sync32.h"),
    // sync32.h includes <stdint.h>, and a freestanding cart has no libc to
    // supply one. A minimal exact-width header for this ABI ships here rather
    // than borrowing newlib's, which drags a hosted header tree behind it.
    "stdint.h": path.join(SHARE, "sysinclude", "stdint.h"),
  },
};

/**
 * Read the SDK assets for one memory mode, as source text ready to hand to
 * the toolchain.
 * @param {"ram"|"xip"} [mode]
 */
export function loadSdk(mode = "ram") {
  const ld = sdk.linkScripts[mode];
  if (!ld) throw new Error(`unknown sync32 mode '${mode}' (expected 'ram' or 'xip')`);
  const includes = {};
  for (const [name, p] of Object.entries(sdk.headers)) includes[name] = readFileSync(p, "utf8");
  return {
    crt0: readFileSync(sdk.crt0, "utf8"),
    linkScript: readFileSync(ld, "utf8"),
    includes,
  };
}
