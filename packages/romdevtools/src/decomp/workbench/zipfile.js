// zipfile.js - the ZIP reading and writing the scratch commands need: list
// members from the central directory, read stored or deflated members, and
// write a plain archive. Enough for decomp.me exports and test fixtures; no
// encryption, no ZIP64 writing.
//
// Plain JS ESM + JSDoc.

import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";

export class BadZipFile extends Error {
  constructor(message) { super(message); this.name = "BadZipFile"; }
}

const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LOCAL_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50, ZIP64_LOCATOR_SIG = 0x07064b50;

/** One member, as the central directory describes it. */
export class ZipInfo {
  constructor(fields) { Object.assign(this, fields); }
  isDir() { return this.filename.endsWith("/"); }
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** A read-only archive over an in-memory buffer. */
export class ZipFile {
  /** @param {string|Buffer} source */
  constructor(source) {
    const buf = typeof source === "string" ? readFileSync(source) : Buffer.from(source);
    this.buf = buf;
    if (buf.length < 22) throw new BadZipFile("File is not a zip file");
    const eocd = findEocd(buf);
    if (eocd < 0) throw new BadZipFile("File is not a zip file");
    let count = buf.readUInt16LE(eocd + 10);
    let cdSize = buf.readUInt32LE(eocd + 12);
    let cdOffset = buf.readUInt32LE(eocd + 16);
    if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) {
      const z64 = Number(buf.readBigUInt64LE(eocd - 20 + 8));
      if (buf.readUInt32LE(z64) !== ZIP64_EOCD_SIG) throw new BadZipFile("Corrupt ZIP64 end of central directory");
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdSize = Number(buf.readBigUInt64LE(z64 + 40));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
    // Tolerate archives with data prepended (self-extractors): the directory
    // really sits cdSize bytes before the end record.
    const concat = eocd - cdSize - cdOffset;
    const base = concat > 0 ? concat : 0;
    const infos = [];
    let p = cdOffset + base;
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) throw new BadZipFile("Bad magic number for central directory");
      const flag = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const crc = buf.readUInt32LE(p + 16);
      let compressSize = buf.readUInt32LE(p + 20);
      let fileSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
      let headerOffset = buf.readUInt32LE(p + 42);
      const rawName = buf.subarray(p + 46, p + 46 + nameLen);
      const filename = flag & 0x800 ? rawName.toString("utf8") : Buffer.from(rawName).toString("latin1");
      const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let e = 0; e + 4 <= extra.length;) {
        const id = extra.readUInt16LE(e), size = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (fileSize === 0xffffffff) { fileSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (compressSize === 0xffffffff) { compressSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (headerOffset === 0xffffffff) { headerOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + size;
      }
      infos.push(new ZipInfo({ filename, flag_bits: flag, compress_type: method, CRC: crc, compress_size: compressSize, file_size: fileSize, header_offset: headerOffset + base }));
      p += 46 + nameLen + extraLen + commentLen;
    }
    this._infos = infos;
  }

  infolist() { return [...this._infos]; }
  namelist() { return this._infos.map((i) => i.filename); }

  /** Member bytes, decompressed and CRC-checked. */
  read(member) {
    const info = typeof member === "string" ? this._infos.find((i) => i.filename === member) : member;
    if (!info) throw new Error(`There is no item named '${member}' in the archive`);
    const buf = this.buf, p = info.header_offset;
    if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIG) throw new BadZipFile("Bad magic number for file header");
    if (info.flag_bits & 0x1) throw new Error(`File '${info.filename}' is encrypted, password required for extraction`);
    const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
    const raw = buf.subarray(start, start + info.compress_size);
    let data;
    if (info.compress_type === 0) data = Buffer.from(raw);
    else if (info.compress_type === 8) {
      try { data = zlib.inflateRawSync(raw); } catch (e) { throw new BadZipFile(`Error -3 while decompressing data: ${e.message}`); }
    } else throw new Error(`That compression method is not supported`);
    if (data.length !== info.file_size) throw new BadZipFile(`Bad size for file '${info.filename}'`);
    if ((zlib.crc32(data) >>> 0) !== info.CRC) throw new BadZipFile(`Bad CRC-32 for file '${info.filename}'`);
    return data;
  }
}

/**
 * Write an archive. Each entry is {name, data, compress?: boolean, flag_bits?}.
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const method = entry.compress ? 8 : 0;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const flag = (entry.flag_bits ?? 0) | (/[^\x00-\x7f]/.test(entry.name) ? 0x800 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flag, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CD_SIG, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flag, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(entry.name.endsWith("/") ? 0x10 : 0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

export function writeZip(path, entries) { writeFileSync(path, buildZip(entries)); }
