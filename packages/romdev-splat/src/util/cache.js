// splat.util.cache_handler. Python splat pickles the cache; this port keeps
// the same keys and comparison rules in a JSON file at the same path.
import { exists, readText, mkdirp, writeText } from '../runtime.js';
import * as log from './log.js';
import { opts } from './options.js';
import { parent } from './pypath.js';

const enc = (v) => JSON.stringify(v, (k, x) => (x instanceof Map ? [...x] : x));

export class Cache {
  constructor(config, useCache, verbose) {
    this.use_cache = useCache;
    this.cache = {};
    if (useCache && exists(opts.cache_path)) {
      try {
        this.cache = JSON.parse(readText(opts.cache_path));
        if (verbose) log.write(`Loaded cache (${Object.keys(this.cache).length} items)`);
      } catch {
        log.write('Not able to load cache file. Discarding old cache', { status: 'warn' });
        this.cache = {};
      }
    }
    const optsKey = enc(config.options === undefined ? null : config.options);
    if (useCache && this.cache.__options__ !== optsKey) {
      if (verbose) log.write('Options changed, invalidating cache');
      this.cache = { __options__: optsKey };
    }
  }

  save(verbose) {
    if (Object.keys(this.cache).length && this.use_cache) {
      if (verbose) log.write('Writing cache');
      mkdirp(parent(opts.cache_path));
      writeText(opts.cache_path, JSON.stringify(this.cache), '\n');
    }
  }

  check_cache_hit(segment, updateOnMiss) {
    if (this.use_cache) {
      const cached = enc(segment.cache());
      const id = segment.unique_id();
      if (cached === this.cache[id]) return true;
      if (updateOnMiss) this.cache[id] = cached;
    }
    return false;
  }
}
