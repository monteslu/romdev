// SPDX-License-Identifier: MIT
// Port of spimdisasm/common/Utils.py (argparse helpers are not ported).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { GlobalConfig, InputEndian } from "./GlobalConfig.js";
import { rabbitizer } from "../rabbitizer.js";
import { pyDecode, UnicodeDecodeError } from "../py/codecs.js";
import { wordToFloat as pyWordToFloat, qwordToDouble as pyQwordToDouble } from "../py/pyfloat.js";
import { hexU, pyInt, pyStrip, splitWs, ValueError } from "../py/pyutils.js";
import { atLeast } from "../version.js";

function fmtArgs(args) {
  return args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
}

export function eprint(...args) {
  process.stderr.write(fmtArgs(args) + "\n");
}

export class SystemExit extends Error {
  constructor(code) {
    super(`SystemExit(${code})`);
    this.name = "SystemExit";
    this.code = code;
  }
}

export function panic(...args) {
  eprint(...args);
  throw new SystemExit(1);
}

export function printQuietless(...args) {
  if (!GlobalConfig.QUIET) process.stdout.write(fmtArgs(args) + "\n");
}

export function eprintQuietless(...args) {
  if (!GlobalConfig.QUIET) {
    if (atLeast("1.39.0")) process.stdout.write(fmtArgs(args) + "\n");
    else process.stderr.write(fmtArgs(args) + "\n");
  }
}

export function epprintQuietless(...args) {
  return eprintQuietless(...args);
}

export function printVerbose(...args) {
  if (!GlobalConfig.QUIET && GlobalConfig.VERBOSE) process.stdout.write(fmtArgs(args) + "\n");
}

export function eprintVerbose(...args) {
  if (!GlobalConfig.QUIET && GlobalConfig.VERBOSE) eprint(...args);
}

export function isStdoutRedirected() {
  return !process.stdout.isTTY;
}

/** Returns the md5 hash of a bytes */
export function getStrHash(byteArray) {
  return createHash("md5").update(byteArray).digest("hex");
}

export function writeBytesToFile(filepath, arrayOfBytes) {
  writeFileSync(String(filepath), arrayOfBytes);
}

/** @deprecated */
export const writeBytearrayToFile = writeBytesToFile;

export function readFileAsBytearray(filepath) {
  if (!existsSync(String(filepath))) return new Uint8Array(0);
  return new Uint8Array(readFileSync(String(filepath)));
}

export function readFile(filepath) {
  const text = readFileSync(String(filepath), "utf8");
  return splitLinesKeepEnds(text).map((x) => pyStrip(x));
}

function splitLinesKeepEnds(text) {
  // file.readlines() semantics with universal newlines
  const out = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\r") {
      cur += "\n";
      if (text[i + 1] === "\n") i++;
      out.push(cur);
      cur = "";
    } else if (c === "\n") {
      cur += c;
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function removeExtraWhitespace(line) {
  return splitWs(line).join(" ");
}

function toU8(b) {
  if (b instanceof Uint8Array) return b;
  if (Array.isArray(b)) return Uint8Array.from(b);
  if (b && b.buffer instanceof ArrayBuffer) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return new Uint8Array(b);
}

export function endianessBytesToWords(endian, arrayOfBytes, offset = 0, offsetEnd = null) {
  let bytes = toU8(arrayOfBytes);
  const totalBytesCount = bytes.length;
  if (totalBytesCount === 0) return [];

  let bytesCount = totalBytesCount;
  let offsetEndHex = "None";
  if (offsetEnd !== null && offsetEnd !== undefined && offsetEnd > 0) {
    bytesCount = offsetEnd;
    offsetEndHex = hexU(offsetEnd);
  }
  bytesCount -= offset;

  if (!(bytesCount >= 0)) throw new Error(`AssertionError: ${hexU(offset)}, ${offsetEndHex}, ${hexU(bytesCount)}, ${hexU(totalBytesCount)}`);
  if (!(offset + bytesCount <= totalBytesCount)) throw new Error(`AssertionError: ${hexU(offset)}, ${offsetEndHex}, ${hexU(bytesCount)}, ${hexU(totalBytesCount)}`);

  if (endian === InputEndian.MIDDLE) {
    // Convert middle endian to big endian
    const halfwords = Math.floor(bytesCount / 2);
    const newBytes = new Uint8Array(bytes);
    for (let h = 0; h < halfwords; h++) {
      const p = offset + h * 2;
      newBytes[p] = bytes[p + 1];
      newBytes[p + 1] = bytes[p];
    }
    bytes = newBytes;
  }

  const words = Math.floor(bytesCount / 4);
  const out = new Array(words);
  const little = endian === InputEndian.LITTLE;
  for (let i = 0; i < words; i++) {
    const p = offset + i * 4;
    if (little) out[i] = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
    else out[i] = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  }
  return out;
}

export function bytesToWords(arrayOfBytes, offset = 0, offsetEnd = null) {
  return endianessBytesToWords(GlobalConfig.ENDIAN, arrayOfBytes, offset, offsetEnd);
}

/** @deprecated */
export const bytesToBEWords = bytesToWords;

export function endianessWordsToBytes(endian, wordsList) {
  if (endian === InputEndian.MIDDLE) {
    throw new Error("BufferError: TODO: wordsToBytesEndianess: GlobalConfig.ENDIAN == InputEndian.MIDDLE");
  }
  const out = new Uint8Array(wordsList.length * 4);
  const little = endian === InputEndian.LITTLE;
  for (let i = 0; i < wordsList.length; i++) {
    const w = wordsList[i];
    if (!(Number.isInteger(w) && w >= 0 && w <= 0xffffffff)) {
      throw new Error("struct.error: 'I' format requires 0 <= number <= 4294967295");
    }
    const p = i * 4;
    if (little) {
      out[p] = w & 0xff;
      out[p + 1] = (w >>> 8) & 0xff;
      out[p + 2] = (w >>> 16) & 0xff;
      out[p + 3] = (w >>> 24) & 0xff;
    } else {
      out[p] = (w >>> 24) & 0xff;
      out[p + 1] = (w >>> 16) & 0xff;
      out[p + 2] = (w >>> 8) & 0xff;
      out[p + 3] = w & 0xff;
    }
  }
  return out;
}

export function wordsToBytes(wordsList) {
  return endianessWordsToBytes(GlobalConfig.ENDIAN, wordsList);
}

/** @deprecated */
export const beWordsToBytes = wordsToBytes;

export function wordToFloat(word) {
  return pyWordToFloat(word);
}

export function qwordToDouble(qword) {
  return pyQwordToDouble(BigInt(qword));
}

export function wordToCurrenEndian(word) {
  if (GlobalConfig.ENDIAN === InputEndian.BIG) return word;
  if (GlobalConfig.ENDIAN === InputEndian.LITTLE) {
    return (((word & 0xff) << 24) | (((word >>> 8) & 0xff) << 16) | (((word >>> 16) & 0xff) << 8) | ((word >>> 24) & 0xff)) >>> 0;
  }
  // MIDDLE
  const hi = (word >>> 16) & 0xffff;
  const lo = word & 0xffff;
  const swap = (h) => ((h & 0xff) << 8) | ((h >>> 8) & 0xff);
  return ((swap(hi) << 16) | swap(lo)) >>> 0;
}

export function qwordToCurrenEndian(word) {
  word = BigInt(word);
  if (GlobalConfig.ENDIAN === InputEndian.BIG) return word;
  if (GlobalConfig.ENDIAN === InputEndian.LITTLE) {
    let r = 0n;
    for (let i = 0n; i < 8n; i++) r |= ((word >> (i * 8n)) & 0xffn) << ((7n - i) * 8n);
    return r;
  }
  // MIDDLE
  const swap = (h) => ((h & 0xffn) << 8n) | ((h >> 8n) & 0xffn);
  const a = swap((word >> 48n) & 0xffffn);
  const b = swap((word >> 32n) & 0xffffn);
  const c = swap((word >> 16n) & 0xffffn);
  const d = swap(word & 0xffffn);
  return (a << 48n) | (b << 32n) | (c << 16n) | d;
}

/** Python csv.reader over lines with '#' comments stripped. */
export function readCsv(filepath) {
  const text = readFileSync(String(filepath), "utf8");
  const lines = splitLinesKeepEnds(text);
  const processedLines = lines.map((x) => pyStrip(x.split("#")[0]));
  const data = [];
  for (const line of processedLines) data.push(parseCsvLine(line));
  return data;
}

/** Minimal csv.reader (default dialect) for a single line without newlines. */
export function parseCsvLine(line) {
  if (line.length === 0) return [];
  const row = [];
  let field = "";
  let inQuotes = false;
  let quotedField = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field.length === 0 && !quotedField) {
      inQuotes = true;
      quotedField = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      quotedField = false;
    } else {
      field += c;
    }
  }
  row.push(field);
  return row;
}

export function parseColonSeparatedPairLine(line) {
  const pairs = new Map();
  // Allow // and # comments
  if (atLeast("1.39.0")) line = pyStrip(line.split("//")[0]);
  else line = pyStrip(line.split("//")[0].split("#")[0]);

  for (const info of line.split(" ")) {
    if (!info.includes(":")) continue;
    const [key, ...vals] = info.split(":");
    pairs.set(key, vals.join(":"));
  }
  return pairs;
}

export function getMaybeIntFromMaybeStr(number, base = 0) {
  if (number === null || number === undefined) return null;
  return pyInt(number, base);
}

export function intFromStr(number, base = 0) {
  try {
    return pyInt(number, base);
  } catch (e) {
    if (e instanceof ValueError) return null;
    throw e;
  }
}

export const TRUEY_VALS = ["true", "on", "yes", "y"];
export const FALSEY_VALS = ["false", "off", "no", "n"];

export function getMaybeBooleyFromMaybeStr(booley) {
  if (booley === null || booley === undefined) return null;
  if (TRUEY_VALS.includes(booley)) return true;
  if (FALSEY_VALS.includes(booley)) return false;
  return null;
}

// Escape characters that are unlikely to be used
const bannedEscapeCharactersBase = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
  0x1c, 0x1d, 0x1e, 0x1f,
];

/** Set of banned characters for the configured version (0x7F was added in 1.36). */
export const bannedEscapeCharacters = new Set([...bannedEscapeCharactersBase, 0x7f]);
const bannedEscapeCharacters135 = new Set(bannedEscapeCharactersBase);

function isBanned(c) {
  return atLeast("1.39.0") ? bannedEscapeCharacters.has(c) : bannedEscapeCharacters135.has(c);
}

export const escapeCharactersSpecialCases = new Set([0x1a, 0x1b, 0x8c, 0x8d]);

function tryDecode(bytes, encoding) {
  try {
    return { ok: true, value: pyDecode(bytes, encoding) };
  } catch (e) {
    if (e instanceof UnicodeDecodeError) return { ok: false };
    throw e;
  }
}

function hex2(c) {
  return `\\x${hexU(c, 2)}`;
}

export function decodeBytesToStrings(buf, offset, stringEncoding, terminator = 0) {
  buf = toU8(buf);
  const result = [];
  let dst = [];
  let i = 0;
  while (offset + i < buf.length && buf[offset + i] !== terminator) {
    const char = buf[offset + i];
    if (isBanned(char)) return [[], -10];

    let validNonAsciiSequence = false;
    if (char > 0x7f) {
      dst.push(char);
      if (tryDecode(Uint8Array.from(dst), stringEncoding).ok) {
        validNonAsciiSequence = true;
      } else if (offset + i + 1 < buf.length) {
        const nextChar = buf[offset + i + 1];
        if (nextChar !== 0x5c) {
          dst.push(nextChar);
          if (tryDecode(Uint8Array.from(dst), stringEncoding).ok) validNonAsciiSequence = true;
          dst.pop();
        }
      }
      dst.pop();

      if (!validNonAsciiSequence && offset + i + 1 < buf.length) {
        const nextChar = buf[offset + i + 1];
        if (nextChar === 0x5c) {
          if (dst.length > 0) {
            const d = tryDecode(Uint8Array.from(dst), stringEncoding);
            if (!d.ok) return [[], -60];
            result.push(rabbitizer.Utils.escapeString(d.value));
            dst = [];
          }
          result.push(hex2(char));
          result.push(hex2(nextChar));
          i += 2;
          continue;
        }
      }
    }

    if (!validNonAsciiSequence && escapeCharactersSpecialCases.has(char)) {
      if (dst.length > 0) {
        const d = tryDecode(Uint8Array.from(dst), stringEncoding);
        if (!d.ok) return [[], -70];
        result.push(rabbitizer.Utils.escapeString(d.value));
        dst = [];
      }
      result.push(hex2(char));
    } else {
      dst.push(char);
    }
    i += 1;
  }

  if (offset + i >= buf.length) {
    // Reached the end of the buffer without finding an 0
    return [[], -80];
  }

  if (dst.length > 0) {
    const d = tryDecode(Uint8Array.from(dst), stringEncoding);
    if (!d.ok) return [[], -90];
    result.push(rabbitizer.Utils.escapeString(d.value));
  }

  // To be a valid aligned string, the next word-aligned bytes needs to be zero
  let checkStartOffset = offset + i;
  const checkEndOffset = Math.min((checkStartOffset & ~3) + 4, buf.length);
  while (checkStartOffset < checkEndOffset) {
    if (buf[checkStartOffset] !== terminator) return [[], -100];
    checkStartOffset += 1;
  }

  return [result, i];
}

export function decodeBytesToPascalStrings(buf, offset, stringEncoding, terminator = 0x20) {
  buf = toU8(buf);
  const result = [];
  let dst = [];
  let i = 0;
  while (offset + i < buf.length) {
    if (buf[offset + i] === terminator) {
      if (offset + i + 1 < buf.length && buf[offset + i + 1] === terminator) {
        // Require at least 2 terminators next to each other to actually consider the string has ended
        break;
      }
    }
    const char = buf[offset + i];
    if (isBanned(char)) {
      return [[], -1];
    } else if (escapeCharactersSpecialCases.has(char)) {
      if (dst.length > 0) {
        const d = tryDecode(Uint8Array.from(dst), stringEncoding);
        if (!d.ok) return [[], -1];
        result.push(rabbitizer.Utils.escapeString(d.value));
        dst = [];
      }
      result.push(hex2(char));
    } else {
      dst.push(char);
    }
    i += 1;
  }

  if (offset + i >= buf.length) {
    return [[], -1];
  }

  // To be a valid aligned string, the next word-aligned bytes needs to be the terminator value
  let checkStartOffset = offset + i;
  const checkEndOffset = Math.min((checkStartOffset & ~3) + 4, buf.length);
  while (checkStartOffset < checkEndOffset) {
    if (buf[checkStartOffset] !== terminator) return [[], -1];
    dst.push(buf[checkStartOffset]);
    checkStartOffset += 1;
    i += 1;
  }

  while (offset + i < buf.length) {
    // Check in chunks of 4 bytes for the terminator value
    let j = 0;
    let onlyTerminator = true;
    while (j < 4 && offset + i + j < buf.length) {
      const char = buf[offset + i + j];
      if (char !== terminator) {
        onlyTerminator = false;
        break;
      }
      j += 1;
    }
    if (!onlyTerminator) break;
    dst.push(terminator, terminator, terminator, terminator);
    i += 4;
  }

  if (dst.length > 0) {
    const d = tryDecode(Uint8Array.from(dst), stringEncoding);
    if (!d.ok) return [[], -1];
    result.push(rabbitizer.Utils.escapeString(d.value));
  }

  return [result, i];
}

/** @deprecated */
export function decodeString(buf, offset, stringEncoding) {
  buf = toU8(buf);
  const result = [];
  let dst = [];
  let i = 0;
  while (offset + i < buf.length && buf[offset + i] !== 0) {
    const char = buf[offset + i];
    if (isBanned(char)) {
      throw new Error("RuntimeError");
    } else if (escapeCharactersSpecialCases.has(char)) {
      if (dst.length > 0) {
        result.push(rabbitizer.Utils.escapeString(pyDecode(Uint8Array.from(dst), stringEncoding)));
        dst = [];
      }
      result.push(hex2(char));
    } else {
      dst.push(char);
    }
    i += 1;
  }
  if (offset + i > buf.length) throw new Error("RuntimeError: Reached the end of the buffer without finding an 0");
  if (dst.length > 0) result.push(rabbitizer.Utils.escapeString(pyDecode(Uint8Array.from(dst), stringEncoding)));
  return [result, i];
}
