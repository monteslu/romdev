// splat.util.statistics
import * as log from './log.js';

function fmtSize(size) {
  if (size > 1000000) return String(Math.floor(size / 1000000)) + ' MB';
  if (size > 1000) return String(Math.floor(size / 1000)) + ' KB';
  return String(size) + ' B';
}

const pct = (r) => (r * 100).toFixed(2) + '%';
const rj = (s, n) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

export class Statistics {
  constructor() { this.seg_sizes = new Map(); this.seg_split = new Map(); this.seg_cached = new Map(); }
  add_size(typ, size) { this.seg_sizes.set(typ, (this.seg_sizes.get(typ) || 0) + (size === null ? 0 : size)); }
  count_split(typ, count = 1) { this.seg_split.set(typ, (this.seg_split.get(typ) || 0) + count); }
  count_cached(typ, count = 1) { this.seg_cached.set(typ, (this.seg_cached.get(typ) || 0) + count); }

  print_statistics(totalSize) {
    const unkSize = this.seg_sizes.get('unk') || 0;
    let restSize = 0;
    for (const [typ, size] of this.seg_sizes) if (typ !== 'unk') restSize += size;
    log.write(`Split ${fmtSize(restSize)} (${pct(restSize / totalSize)}) in defined segments`);
    for (const [typ, size] of this.seg_sizes) {
      if (typ === 'unk') continue;
      log.write(`${rj(typ, 20)}: ${rj(fmtSize(size), 8)} (${pct(size / totalSize)}) \x1b[32m${this.seg_split.get(typ) || 0} split\x1b[0m, \x1b[2m${this.seg_cached.get(typ) || 0} cached`);
    }
    log.write(`${rj('unknown', 20)}: ${rj(fmtSize(unkSize), 8)} (${pct(unkSize / totalSize)}) from unknown bin files`);
  }
}
