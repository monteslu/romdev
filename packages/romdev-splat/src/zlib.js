// Vanilla zlib (WASM) with CPython zlib-module call semantics:
// compressobj(level, DEFLATED, wbits, memLevel, strategy).compress()/flush()
// and crc32(). See src/wasm/zlib-stream.wasm (scripts/build-zlib-wasm.sh).
import fs from 'node:fs';

let inst = null;

function wasm() {
  if (inst) return inst;
  const bytes = fs.readFileSync(new URL('./wasm/zlib-stream.wasm', import.meta.url));
  const mod = new WebAssembly.Module(bytes);
  inst = new WebAssembly.Instance(mod, { env: { emscripten_notify_memory_growth() {} } }).exports;
  if (inst._initialize) inst._initialize();
  return inst;
}

const Z_NO_FLUSH = 0;
const Z_FINISH = 4;

function withInput(e, data, fn) {
  const n = data.length;
  const p = e.zs_malloc(n);
  new Uint8Array(e.memory.buffer, p, n).set(data);
  try { return fn(p, n); } finally { e.zs_mfree(p); }
}

export class Compress {
  /** zlib.compressobj(level=-1, method=DEFLATED, wbits=15, memLevel=8, strategy=0) */
  constructor(level = -1, wbits = 15, memLevel = 8, strategy = 0) {
    const e = wasm();
    this.h = e.zs_new(level, wbits, memLevel, strategy);
    if (!this.h) throw new Error('zlib: deflateInit2 failed');
  }

  _run(data, flush) {
    const e = wasm();
    const rc = withInput(e, data, (p, n) => e.zs_compress(this.h, p, n, flush));
    if (rc !== 0) throw new Error(`zlib: deflate error ${rc}`);
    const ptr = e.zs_out_ptr(this.h);
    const len = e.zs_out_len(this.h);
    return Buffer.from(new Uint8Array(e.memory.buffer, ptr, len));
  }

  compress(data) { return this._run(data, Z_NO_FLUSH); }

  flush() {
    const out = this._run(new Uint8Array(0), Z_FINISH);
    wasm().zs_free(this.h);
    this.h = 0;
    return out;
  }
}

export function compressobj(level = -1, wbits = 15, memLevel = 8, strategy = 0) {
  return new Compress(level, wbits, memLevel, strategy);
}

/** zlib.crc32(data, value=0) */
export function crc32(data, value = 0) {
  const e = wasm();
  return withInput(e, data, (p, n) => e.zs_crc32(value >>> 0, p, n) >>> 0);
}
