// intent.js — R17 intent axis for the asset-pipeline tools.
//
// Two values. Required arg on every asset-pipeline tool that touches
// palettes / quantization / validation:
//
//   "homebrew"  — caller is shaping art for a known platform. Color
//                 defaults, indexed PNG with PLTE, platform-master
//                 quantization, enforce platform limits, how-to-fix
//                 error messages.
//
//   "rom-hack"  — caller is investigating unknown bytes / cross-
//                 platform forensics. Grayscale defaults, frequency
//                 quantization (preserve "what's there"), warn-but-
//                 allow validation, terse byte-level errors.
//
// No default — agents pick at every call. The dichotomy is
// "shaping art for a target" vs "investigating bytes I didn't author."

export const VALID_INTENTS = ["homebrew", "rom-hack"];

/**
 * Resolved bundle of defaults for a given intent. Tools read fields
 * off this object instead of branching on the string everywhere.
 *
 * @typedef {Object} IntentDefaults
 * @property {string} colorMode               — "live-or-platform" | "grayscale"
 * @property {string} quantizeMode            — "platform-master" | "frequency"
 * @property {boolean} autoQuantize           — true under homebrew, false under rom-hack
 * @property {"enforce"|"warn"} validation    — platform-limit policy
 * @property {"how-to-fix"|"terse"} errorTone — how diagnostics are phrased
 * @property {boolean} chrSizeWarnings        — emit "CHR is large / mostly blank" warnings
 * @property {boolean} crossBankWarnings      — emit rom-hack-specific warnings
 *                                              (e.g. "this tile is referenced from PRG via LDA #imm")
 * @property {string} intent                  — echo of the original value
 */

/**
 * Resolve an intent string to its default bundle.
 * @param {string} intent
 * @returns {IntentDefaults}
 */
export function resolveIntent(intent) {
  if (intent === "homebrew") {
    return {
      intent,
      colorMode:         "live-or-platform",
      quantizeMode:      "platform-master",
      autoQuantize:      true,
      validation:        "enforce",
      errorTone:         "how-to-fix",
      chrSizeWarnings:   true,
      crossBankWarnings: false,
    };
  }
  if (intent === "rom-hack") {
    return {
      intent,
      colorMode:         "grayscale",
      quantizeMode:      "frequency",
      autoQuantize:      false,
      validation:        "warn",
      errorTone:         "terse",
      chrSizeWarnings:   false,
      crossBankWarnings: true,
    };
  }
  throw new Error(
    `intent must be 'homebrew' or 'rom-hack', got ${JSON.stringify(intent)}. ` +
    `homebrew = shaping art for a target platform (color, indexed PNG, enforce limits). ` +
    `rom-hack = investigating bytes / cross-platform forensics (grayscale, raw, warn-but-allow).`
  );
}

/**
 * Standard zod schema fragment for the `intent` arg. Use in every
 * tool that takes the intent axis:
 *
 *   intent: intentZod(z)
 */
export function intentZod(z) {
  return z.enum(VALID_INTENTS).describe(
    "REQUIRED. Pick your audience: " +
    "'homebrew' = shaping art for a target platform — color defaults from " +
    "live emulator or per-platform palette, indexed PNG with PLTE, " +
    "platform-master quantization, enforce platform palette limits, " +
    "how-to-fix error messages. " +
    "'rom-hack' = investigating unknown bytes or doing cross-platform " +
    "forensics — grayscale defaults, frequency-based quantize (preserve " +
    "what's there), warn-but-allow validation, terse byte-level errors. " +
    "No default — pick at every call."
  );
}

/**
 * Format an error message according to the intent's tone.
 *
 * Homebrew → caller cares about how to fix. Append a hint with
 * editor/Lospec/source-side guidance when supplied.
 * Rom-hack → caller cares about the byte-level fact. Strip the hint.
 *
 * @param {string} fact         — the underlying error fact (e.g. "5 colors > 4")
 * @param {string} hint         — homebrew-style "how to fix" guidance
 * @param {IntentDefaults} d
 * @returns {string}
 */
export function intentError(fact, hint, d) {
  if (d.errorTone === "how-to-fix" && hint) {
    return `${fact}\n  ${hint}`;
  }
  return fact;
}
