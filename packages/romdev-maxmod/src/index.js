// romdev-maxmod — pure-JS Maxmod soundbank compiler for the GBA.
//
// A faithful port of devkitPro/blocksds `mmutil`: parses a tracker module
// (.xm / .mod / .it / .s3m) and emits a Maxmod **MAS soundbank** (.bin + .h)
// you link into a GBA ROM and play with the Maxmod runtime (mmStart()).
// No native binary, no devkitPro.
//
//   module bytes ──parse(mod|xm|it|s3m)──► MASModule ──writeSoundbank──► {bin, header}
//
// Typical use:
//   import { soundbankFromModule } from 'romdev-maxmod';
//   const { bin, header } = soundbankFromModule(xmBytes, { name: 'mysong' });
//   // bin → soundbank_bin.h / .bin you mmInitDefault() against;
//   // header → the MOD_<NAME> / MSL_* #defines.

import { parseMod } from './mod.js';
import { parseXm } from './xm.js';
import { parseIt } from './it.js';
import { parseS3m } from './s3m.js';
import { writeSoundbank, writeMAS, printDefinition } from './mas.js';
import { FixSample } from './samplefix.js';

/** A 4-char ASCII tag at `off` equals `sig`? */
function tagAt(bytes, off, sig) {
  if (off + sig.length > bytes.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[off + i] !== sig.charCodeAt(i)) return false;
  return true;
}

/**
 * Sniff a tracker module's format from its content (mmutil dispatches by file
 * extension; we get bytes, so we match magic the same way each parser does).
 * @param {Uint8Array} bytes
 * @returns {'it'|'xm'|'s3m'|'mod'|null}
 */
export function detectModuleFormat(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (tagAt(bytes, 0, 'IMPM')) return 'it';                         // it.c
  if (tagAt(bytes, 0, 'Extended Module: ')) return 'xm';            // xm.c
  if (tagAt(bytes, 0x2c, 'SCRM')) return 's3m';                     // s3m.c (sig @ 0x2C)
  // MOD has no leading magic; its 4-char tag lives at offset 1080.
  if (bytes.length >= 1084) {
    for (const t of ['M.K.', 'M!K!', '4CHN', '6CHN', '8CHN', 'FLT4', 'FLT8', 'CD81', 'OKTA', '16CN', '32CN']) {
      if (tagAt(bytes, 1080, t)) return 'mod';
    }
  }
  return null;
}

/**
 * Parse a tracker module of any supported format into the shared MASModule model.
 * @param {Uint8Array} bytes  raw .xm/.mod/.it/.s3m
 * @param {Object} [opts]  forwarded to the parser (e.g. fixSample hook)
 * @param {'it'|'xm'|'s3m'|'mod'} [opts.format]  override the sniffed format
 * @returns {object} the parsed MASModule
 */
export function parseModule(bytes, opts = {}) {
  const fmt = opts.format || detectModuleFormat(bytes);
  // mmutil's loaders ALWAYS call FixSample(samp) after delta-decoding a sample
  // (it's in the loaders' code path, not optional). We split FixSample into a
  // separate module to mirror samplefix.c, so inject it as the default here
  // unless the caller deliberately overrode it (e.g. to inspect raw PCM).
  const popts =
    Object.prototype.hasOwnProperty.call(opts, 'fixSample') ? opts : { ...opts, fixSample: FixSample };
  switch (fmt) {
    case 'it':  return parseIt(bytes, popts);
    case 'xm':  return parseXm(bytes, popts);
    case 's3m': return parseS3m(bytes, popts);
    case 'mod': return parseMod(bytes, popts);
    default:
      throw new Error('romdev-maxmod: unrecognized module format (expected .it/.xm/.s3m/.mod). Pass opts.format to override.');
  }
}

/**
 * One-call compile: a module (any supported format) → a GBA Maxmod soundbank.
 * @param {Uint8Array} bytes  raw .xm/.mod/.it/.s3m
 * @param {Object} [opts]
 * @param {string} [opts.name]  name for the MOD_<NAME> #define (else the module title)
 * @param {'it'|'xm'|'s3m'|'mod'} [opts.format]  override the sniffed format
 * @returns {{bin: Uint8Array, header: string}}  the soundbank .bin + the .h #defines
 */
export function soundbankFromModule(bytes, opts = {}) {
  const mod = parseModule(bytes, opts);
  const moduleMeta = opts.name ? [{ filename: opts.name }] : [];
  return writeSoundbank([mod], [], { moduleMeta });
}

export { parseMod, parseXm, parseIt, parseS3m, writeSoundbank, writeMAS, printDefinition };
export default soundbankFromModule;
