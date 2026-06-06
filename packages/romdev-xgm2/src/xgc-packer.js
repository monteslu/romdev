// Port of sgdk.xgm2tool.tool.XGCPacker — XGC LZ-style block packer/unpacker.

const LITERAL_MAX_SIZE = 7;
const MATCH_MAX_SIZE = 31;
const MATCH_OFFSET_MAX = 0x100;

const FRAME_MIN_SIZE = 32;
const FRAME_MAX_SIZE = 256;
// to lower unpacking time
// const FRAME_MAX_SIZE = 128;

/**
 * Growable byte buffer mirroring Java's ByteArrayOutputStream subclass that
 * also supports indexed reads. Bytes are stored 0..255.
 */
class DynamicByteArray {
  constructor() {
    /** @type {number[]} */
    this.buf = [];
  }

  /** @returns {number} number of bytes written (Java `count`/`size()`). */
  size() {
    return this.buf.length;
  }

  /** Append a single byte (low 8 bits). */
  write(value) {
    this.buf.push(value & 0xff);
  }

  /**
   * @param {number} off
   * @returns {number} byte at `off` (0..255).
   */
  read(off) {
    if (off < 0 || off >= this.buf.length) throw new Error("IndexOutOfBoundsException");
    return this.buf[off];
  }

  /** @returns {Uint8Array} */
  toByteArray() {
    return Uint8Array.from(this.buf);
  }
}

/**
 * A ByteMatch entry: an offset and a repeat count. Comparable by offset.
 */
class ByteMatch {
  /**
   * @param {number} offset
   * @param {number} repeat
   */
  constructor(offset, repeat) {
    this.offset = offset;
    this.repeat = repeat;
  }

  toString() {
    return "Off=" + this.offset + " - Repeat=" + this.repeat;
  }

  /**
   * @param {ByteMatch} bm
   * @returns {number}
   */
  compareTo(bm) {
    return this.offset - bm.offset;
  }
}

/**
 * A candidate match between a current offset and a reference offset.
 */
class Match {
  /**
   * @param {number} curOff current offset (offset of what we want to compress)
   * @param {number} refOff reference offset
   * @param {number} len match length
   */
  constructor(curOff, refOff, len) {
    this.curOffset = curOff;
    this.refOffset = refOff;
    this.length = len;
    this.cost = 2;
    this.saved = len - this.cost;
  }

  /**
   * @returns {number} relative offset (positive)
   */
  getRelativeOffset() {
    return Math.abs(this.curOffset - this.refOffset);
  }

  /**
   * @param {number} offset
   * @returns {boolean}
   */
  fixForExtraByte(offset) {
    const relativeOffset = this.getRelativeOffset();

    // impacted ?
    if (offset < relativeOffset) {
      // get maximum allowed len for match
      const maxLen = relativeOffset - offset;

      // above max len ? --> cannot be used
      if (this.length >= maxLen) {
        return false;
      }

      // fix offset
      this.refOffset--;
    }

    // not impacted
    return true;
  }

  toString() {
    return (
      "off=" +
      this.getRelativeOffset().toString(16).toUpperCase() +
      ", len=" +
      this.length +
      " saved=" +
      this.saved
    );
  }
}

/** MAX_SAVED constant (was a static field on Match in Java). */
Match.MAX_SAVED = MATCH_MAX_SIZE - 1;

/**
 * XGC LZ-style block packer/unpacker.
 */
export class XGCPacker {
  static get LITERAL_MAX_SIZE() {
    return LITERAL_MAX_SIZE;
  }
  static get MATCH_MAX_SIZE() {
    return MATCH_MAX_SIZE;
  }
  static get MATCH_OFFSET_MAX() {
    return MATCH_OFFSET_MAX;
  }
  static get FRAME_MIN_SIZE() {
    return FRAME_MIN_SIZE;
  }
  static get FRAME_MAX_SIZE() {
    return FRAME_MAX_SIZE;
  }

  /**
   * @param {Uint8Array|number[]} data
   * @param {number} ind
   * @returns {number}
   */
  static getRepeat(data, ind) {
    const value = data[ind] & 0xff;

    let off = ind + 1;
    while (off < data.length && (data[off] & 0xff) === value) off++;

    return off - ind - 1;
  }

  /**
   * @param {Uint8Array|number[]} data
   * @param {number} from
   * @param {number} ind
   * @returns {Match}
   */
  static findBestMatchInternal(data, from, ind) {
    let refOffset;
    let curOffset;
    let len;

    // test on simple copy
    refOffset = from;
    curOffset = ind;
    len = 0;
    while (
      curOffset < data.length &&
      (data[refOffset++] & 0xff) === (data[curOffset++] & 0xff) &&
      len < MATCH_MAX_SIZE
    )
      len++;

    return new Match(ind, from, len);
  }

  /**
   * @param {ByteMatch[][]} byteMatches
   * @param {Uint8Array|number[]} data
   * @param {number} ind
   * @returns {Match|null}
   */
  static findBestMatch(byteMatches, data, ind) {
    // nothing we can do
    if (ind < 1) return null;

    // get word matches for current word
    const bml = byteMatches[data[ind] & 0xff];
    // window search size = 255
    const offMin = Math.max(0, ind - MATCH_OFFSET_MAX);

    // find starting index in word match list
    let bmlInd = 0;
    while (bmlInd < bml.length) {
      const wm = bml[bmlInd];

      // accepted offset ? --> start here
      if (wm.offset + wm.repeat >= offMin) break;

      bmlInd++;
    }

    // get number of repeat for current byte
    const curRepeat = XGCPacker.getRepeat(data, ind);

    let best = null;
    let saved = 0;

    // for all accepted matches
    while (bmlInd < bml.length) {
      const wm = bml[bmlInd];

      let off = wm.offset;
      let repeat = wm.repeat;

      // raised current offset ? --> stop now
      if (off >= ind) break;

      // need to adjust start ?
      if (off < offMin) {
        repeat -= offMin - off;
        off = offMin;
      }

      // can optimize repeat ?
      if (off >= 0 || off + repeat < 0) {
        // less repeat on match
        if (repeat < curRepeat) {
          const match = new Match(ind, off, Math.min(MATCH_MAX_SIZE, repeat + 1));

          // use >= as we always prefer match to literal
          if (match.saved >= saved) {
            best = match;
            saved = match.saved;

            // maximum saved ? --> don't continue
            if (saved >= Match.MAX_SAVED) return best;
          }
        } else {
          // more repeat on match ?
          if (repeat > curRepeat) {
            // bypass extras repeats on match
            let delta = repeat - curRepeat;
            // fix maximum delta to not raise ind
            if (off + delta >= ind) delta = ind - off - 1;

            off += delta;
            repeat -= delta;
          }

          let match;

          // still some repeat ?
          if (repeat > 0) {
            // we raised ind ? --> limit start offset to (ind - 1)
            if (off + repeat >= ind) repeat = ind - off - 1;

            // easy optimization (start comparing after repeat)
            match = XGCPacker.findBestMatchInternal(data, off + repeat, ind + repeat);
            // then fix the match
            match = new Match(
              match.curOffset - repeat,
              match.refOffset - repeat,
              Math.min(MATCH_MAX_SIZE, match.length + repeat)
            );
          } else match = XGCPacker.findBestMatchInternal(data, off, ind);

          // use >= as we always prefer match to literal
          if (match.saved >= saved) {
            best = match;
            saved = match.saved;

            // maximum saved ? --> don't continue
            if (saved === Match.MAX_SAVED) return best;
          }
        }
      } else {
        // for each repeated byte
        while (repeat-- >= 0 && off < ind) {
          const match = XGCPacker.findBestMatchInternal(data, off, ind);

          // use >= as we always prefer match to literal
          if (match.saved >= saved) {
            best = match;
            saved = match.saved;

            // maximum saved ? --> don't continue
            if (saved === Match.MAX_SAVED) return best;
          }

          off++;
        }
      }

      // next word match
      bmlInd++;
    }

    return best;
  }

  /**
   * @param {number[]} frameOffsets
   * @param {number} startInd
   * @param {number} curOffset
   * @returns {number}
   */
  static getMaxFrameOffsetFor(frameOffsets, startInd, curOffset) {
    let ind = startInd;
    const maxOff = curOffset + FRAME_MAX_SIZE;

    while (ind < frameOffsets.length && frameOffsets[ind] < maxOff) ind++;

    return frameOffsets[Math.max(--ind, startInd)];
  }

  /**
   * @param {DynamicByteArray} result
   * @param {Uint8Array|number[]} literal
   * @param {Match|null} match
   * @param {number} baseAlign
   * @param {Int32Array} literalLen
   * @param {Int32Array} matchLen
   * @param {Int32Array} matchOffset
   */
  static addBlockBytes(result, literal, match, baseAlign, literalLen, matchLen, matchOffset) {
    let literalData = literal;
    const start = result.size();
    const blockSize = literalData.length + (match != null ? 2 : 1);
    const end = start + (blockSize - 1);

    literalLen[literalData.length]++;

    // crossing page (need to split) ?
    if (((start + baseAlign) & 0xff00) !== ((end + baseAlign) & 0xff00)) {
      // remaining byte in first page
      const firstPageRemain = 0x100 - ((start + baseAlign) & 0xff);

      // write first part of literal data
      if (firstPageRemain > 1) {
        const len = firstPageRemain - 1;

        // write block header with page cross marker
        result.write((len << 5) | 1);
        // write literal data
        for (let i = 0; i < len; i++) result.write(literalData[i]);

        // remaining literal data
        literalData = literalData.slice(len, literalData.length);
      }
      // just write cross page marker
      else result.write(1);
    }

    // match type data block
    if (match != null) {
      const off = match.getRelativeOffset();

      matchLen[match.length]++;
      matchOffset[off]++;

      // literal + match length
      result.write((literalData.length << 5) | match.length);
      // copy literal data if any
      for (let i = 0; i < literalData.length; i++) result.write(literalData[i]);
      // write match offset *after* literal data (simpler for unpacking)
      result.write(-off & 0xff);
    }
    // literal only data block
    else {
      matchLen[0]++;

      // write literal data only if not empty
      if (literalData.length > 0) {
        // literal header
        result.write(literalData.length << 5);
        // copy literal data
        for (let i = 0; i < literalData.length; i++) result.write(literalData[i]);
      }
    }
  }

  /**
   * @param {DynamicByteArray} result
   * @param {number[]} literal accumulating literal byte buffer
   * @param {Match|null} match
   * @param {number} baseAlign
   * @param {Int32Array} literalLen
   * @param {Int32Array} matchLen
   * @param {Int32Array} matchOffset
   */
  static addBlock(result, literal, match, baseAlign, literalLen, matchLen, matchOffset) {
    XGCPacker.addBlockBytes(
      result,
      Uint8Array.from(literal),
      match,
      baseAlign,
      literalLen,
      matchLen,
      matchOffset
    );
    // reset literal buffer
    literal.length = 0;
  }

  /**
   * @param {Uint8Array|number[]} data
   * @param {number[]} frameOffsets
   * @param {number} baseAlign
   * @returns {Uint8Array}
   */
  static pack(data, frameOffsets, baseAlign) {
    if (data == null || data.length === 0) return new Uint8Array(0);

    const result = new DynamicByteArray();
    /** @type {number[]} */
    const literal = [];

    // per-call stats arrays (Java used static fields, reset in PASS 4)
    const literalLen = new Int32Array(LITERAL_MAX_SIZE + 1);
    const matchLen = new Int32Array(MATCH_MAX_SIZE + 1);
    const matchOffset = new Int32Array(MATCH_OFFSET_MAX + 2);

    // PASS 1: build the byte matches table
    /** @type {ByteMatch[][]} */
    const byteMatches = new Array(0x100);
    for (let i = 0; i < byteMatches.length; i++) byteMatches[i] = [];

    // current offset to start counting matches
    let mOffset = 0;
    while (mOffset < data.length) {
      const off = mOffset;
      const val = data[mOffset++] & 0xff;

      let repeat = 0;
      while (mOffset < data.length && (data[mOffset] & 0xff) === val) {
        repeat++;
        mOffset++;
      }

      // need to unsign val / add new byte match
      byteMatches[val].push(new ByteMatch(off, repeat));
    }

    // sort all ByteMatch list
    for (let i = 0; i < byteMatches.length; i++)
      byteMatches[i].sort((a, b) => a.compareTo(b));

    // PASS 2: get best match for each source position using the word matches table
    /** @type {(Match|null)[]} */
    const matches = new Array(data.length);

    for (let i = 0; i < matches.length; i++)
      matches[i] = XGCPacker.findBestMatch(byteMatches, data, i);

    // PASS 3: walk backward in matches and find optimal match length
    const costs = new Int32Array(matches.length + 1);

    // initialize ending cost
    costs[matches.length] = 0;

    for (let i = matches.length - 1; i >= 0; i--) {
      // literal cost = next cost + 1
      const literalCost = costs[i + 1] + 1;
      // default match cost
      let matchCost = 0x7fffffff;

      const match = matches[i];

      // we have a match ? its cost = current match cost + cost after match sequence
      if (match != null) matchCost = match.cost + costs[i + match.length];

      // literal cost is cheaper than match cost ?
      if (literalCost < matchCost) {
        // change the match to a literal as it is more efficient
        costs[i] = literalCost;
        matches[i] = null;
      } else costs[i] = matchCost;
    }

    // PASS 4: build compressed data from optimal matches
    literalLen.fill(0);
    matchLen.fill(0);
    matchOffset.fill(0);

    literal.length = 0;
    let nextFrameOffset = frameOffsets[0];
    let maxNextFrameOffset = Math.max(
      XGCPacker.getMaxFrameOffsetFor(frameOffsets, 0, 0),
      nextFrameOffset
    );
    let ind = 0;
    let lastFrameStart = 0;
    let frameInd = 1;
    while (ind < matches.length) {
      const frameSize = ind - lastFrameStart;
      let match = matches[ind];
      const blockSize = match != null ? match.length : 1;

      // get next frame start offset
      while (nextFrameOffset < ind && frameInd < frameOffsets.length)
        nextFrameOffset = frameOffsets[frameInd++];

      // !! fatal error (should never happen) !!
      if (frameSize >= FRAME_MAX_SIZE)
        throw new Error("Error: max frame size reached at frame #" + (frameInd - 1));

      // aligned on the end of frame ?
      let accept = ind === nextFrameOffset;
      if (accept) {
        // frame size is big enough or we reached maximum allowed offset ?
        accept = accept && (frameSize >= FRAME_MIN_SIZE || ind === maxNextFrameOffset);

        if (accept) {
          // (large-frame verbose warning dropped)

          // literal not empty ? --> add literal block first
          if (literal.length > 0)
            XGCPacker.addBlock(result, literal, null, baseAlign, literalLen, matchLen, matchOffset);

          // add end frame unpack block marker
          result.write(0);
          lastFrameStart = ind;

          // get max next end frame offset
          maxNextFrameOffset = XGCPacker.getMaxFrameOffsetFor(frameOffsets, frameInd, ind);
          // get next end frame offset
          while (nextFrameOffset <= ind && frameInd < frameOffsets.length)
            nextFrameOffset = frameOffsets[frameInd++];
        }
      }

      // was not accepted ?
      if (!accept) {
        // above max frame offset ? --> cancel match so we can stop on next frame
        if (ind + blockSize > maxNextFrameOffset) {
          match = null;
        }
      }

      // match found ?
      if (match != null) {
        // add a new block
        XGCPacker.addBlock(result, literal, match, baseAlign, literalLen, matchLen, matchOffset);
        // next ind
        ind += match.length;
      }
      // no match found --> add to literal buffer
      else {
        // max size for literal ? --> flush it
        if (literal.length >= LITERAL_MAX_SIZE)
          XGCPacker.addBlock(result, literal, null, baseAlign, literalLen, matchLen, matchOffset);

        // write to literal and pass to next ind
        literal.push(data[ind++] & 0xff);
      }
    }

    // literal not empty ? --> add last literal block
    if (literal.length > 0)
      XGCPacker.addBlock(result, literal, null, baseAlign, literalLen, matchLen, matchOffset);

    // end marker
    result.write(0);

    // (compression-stats verbose output dropped)

    return result.toByteArray();
  }

  /**
   * @param {Uint8Array|number[]} data
   * @param {Uint8Array|number[]|null} verif
   * @returns {Uint8Array}
   */
  static unpack(data, verif) {
    const result = new DynamicByteArray();

    let ind = 0;
    while (ind < data.length) {
      const block = data[ind++] & 0xff;
      const litSize = (block >> 5) & 0x07;
      const matSize = (block >> 0) & 0x1f;

      // get offset
      const matOff = matSize > 1 ? data[ind++] & 0xff : 0;

      // write literal
      for (let i = 0; i < litSize; i++) {
        result.write(data[ind++]);
        if (verif != null && (verif[result.size() - 1] & 0xff) !== result.read(result.size() - 1)) {
          // verification mismatch (verbose output dropped)
        }
      }

      if (matSize > 1) {
        let off = result.size() - matOff;
        for (let i = 0; i < matSize; i++) {
          result.write(result.read(off++));
          if (
            verif != null &&
            (verif[result.size() - 1] & 0xff) !== result.read(result.size() - 1)
          ) {
            // verification mismatch (verbose output dropped)
          }
        }
      }
    }

    return result.toByteArray();
  }
}
