// SPDX-License-Identifier: MIT
// Internal helpers for the elf32 port (struct unpacking, Python enum calls).

import { GlobalConfig, InputEndian } from "../common/GlobalConfig.js";
import { ValueError } from "../py/pyutils.js";

export class StructError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "struct.error";
  }
}

/** struct.unpack_from for the codes used by the elf32 modules (B H I i). */
export function unpackFrom(fmt, bytes, offset = 0) {
  let little;
  let spec = fmt;
  if (spec[0] === "<") little = true;
  else if (spec[0] === ">") little = false;
  else throw new Error(`unsupported struct format '${fmt}'`);
  spec = spec.slice(1);
  const codes = [];
  for (const m of spec.matchAll(/(\d*)([BHIi])/g)) {
    const n = m[1] === "" ? 1 : Number.parseInt(m[1], 10);
    for (let i = 0; i < n; i++) codes.push(m[2]);
  }
  const sizes = { B: 1, H: 2, I: 4, i: 4 };
  const total = codes.reduce((a, c) => a + sizes[c], 0);
  if (offset < 0 || offset + total > bytes.length) {
    throw new StructError(`unpack_from requires a buffer of at least ${offset + total} bytes for unpacking ${total} bytes at offset ${offset} (actual buffer size is ${bytes.length})`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let p = offset;
  for (const c of codes) {
    if (c === "B") out.push(dv.getUint8(p));
    else if (c === "H") out.push(dv.getUint16(p, little));
    else if (c === "I") out.push(dv.getUint32(p, little));
    else out.push(dv.getInt32(p, little));
    p += sizes[c];
  }
  return out;
}

/** GlobalConfig.ENDIAN.toFormatString() */
export function endianFmt() {
  return GlobalConfig.ENDIAN.toFormatString();
}

export { InputEndian };

/** Python `EnumClass(value)`: member or ValueError. */
export function enumCall(E, value) {
  const m = E.fromValueOrNull(value);
  if (m === null) throw new ValueError(`${value} is not a valid ${E.__name}`);
  return m;
}

/** Python `EnumClass.fromValue(value)`: member or null. */
export function enumFromValue(E, value) {
  return E.fromValueOrNull(value);
}

/**
 * Add Python enum aliases (e.g. SYSV = NONE). Aliases resolve to the same
 * member object; iteration and `members` keep only canonical members.
 */
export function withAliases(E, aliases) {
  const out = Object.create(E);
  for (const [alias, target] of Object.entries(aliases)) {
    Object.defineProperty(out, alias, { value: E[target], enumerable: true });
  }
  return Object.freeze(out);
}

/** Python repr of an Enum member: <Cls.NAME: value> */
export function enumRepr(m) {
  return `<${m.__enumName}.${m.name}: ${m.value}>`;
}

/** Python `bytes.decode()` (strict UTF-8). */
const utf8 = new TextDecoder("utf-8", { fatal: true });
export function decodeUtf8(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    const e = new Error("UnicodeDecodeError: 'utf-8' codec can't decode bytes");
    e.name = "UnicodeDecodeError";
    throw e;
  }
}

/** Python str(list_of_ints) / repr of a dataclass field value. */
export function pyReprValue(v) {
  if (v === null || v === undefined) return "None";
  if (Array.isArray(v)) return `[${v.map(pyReprValue).join(", ")}]`;
  if (typeof v === "string") return `'${v}'`;
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "object" && typeof v.__repr__ === "function") return v.__repr__();
  return String(v);
}

/** dataclass-style repr: Cls(a=1, b=2) */
export function dataclassRepr(name, obj, fields) {
  return `${name}(${fields.map((f) => `${f}=${pyReprValue(obj[f])}`).join(", ")})`;
}
