// Hand-built minimal IDO phase streams for tests, synthesized from the record
// formats the decoders document (opcode numbers from the published Ucode
// enum, widths from the same table the parser uses). No stream or fragment
// of any real compilation is used.
import { OPCODE_NAMES } from "../../../src/decomp/workbench/ucode.js";

const UCODE_WIDTHS = { lab: 4, ldef: 4, nop: 2, ret: 2, ujp: 2, fjp: 2, tjp: 2, neq: 2 };

export function uword(...values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
  return b;
}

/** One Ucode record with the width its opcode declares. */
export function urecord(name, operands = [], { dtype = 6, mtype = 3, lexlev = 0 } = {}) {
  const header = ((OPCODE_NAMES.indexOf(name) << 24) | (mtype << 21) | (dtype << 16) | lexlev) >>> 0;
  const words = [header, ...operands];
  const width = UCODE_WIDTHS[name];
  if (words.length > width) throw new Error(`U${name} holds ${width} words, got ${words.length}`);
  while (words.length < width) words.push(0);
  return uword(...words);
}

/** A five-record Ucode stream with two labels and one jump. */
export function ucodeStream() {
  return Buffer.concat([urecord("lab", [1, 0, 2]), urecord("nop"), urecord("ujp", [5]), urecord("lab", [5, 0, 2]), urecord("ret")]);
}

export const binasmRecord = (...words) => uword(...words);
export const FLOAT_LITERAL_WORD = 0x001701F8;

export function binasmLiteralPayload(text) {
  const raw = Buffer.from(text, "ascii");
  const padded = (16 - (raw.length % 16)) % 16;
  return Buffer.concat([raw, Buffer.alloc(padded, 0x20)]);
}

/** A Binasm stream whose middle record is a float literal plus its digits. */
export function binasmLiteralStream() {
  const literal = "3.0517578125000000e-05";
  return Buffer.concat([binasmRecord(0, 0x002A0000, 7, 0xA), binasmRecord(0, 0x00150000, 0, 0), binasmRecord(0, FLOAT_LITERAL_WORD, 0, literal.length),
    binasmLiteralPayload(literal), binasmRecord(0, 0x001C0000, 28, 85)]);
}

/** A five-record Binasm stream covering header, code, and a label. */
export function binasmStream() {
  return Buffer.concat([binasmRecord(0, 0x002A0000, 7, 0xA), binasmRecord(0, 0x00150000, 0, 0), binasmRecord(0, 0x001C0000, 28, 85),
    binasmRecord(0, 0x00170062, 0x040D4000, 0), binasmRecord(0xFFFFFFDB, 0, 0, 0)]);
}
