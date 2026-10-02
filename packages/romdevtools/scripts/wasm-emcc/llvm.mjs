// llvm.mjs - run the WASM-hosted LLVM (clang, wasm-ld, llvm-ar, llvm-objcopy...)
// from @yowasp/clang against the REAL disk, the way emscripten's NODERAWFS
// does for its own programs.
//
// @yowasp/clang is LLVM compiled to a WASI preview-2 component (jco-transpiled
// to core wasm + JS). Its stock runtime runs every command in an in-memory
// tree that the caller packs and unpacks, which would mean copying the whole
// emscripten sysroot in and the outputs back out per compile. Here the same
// component is instantiated with a filesystem whose root is the host's `/`
// (looked up lazily, written through), with the toolchain's own resource tree
// (clang builtin headers, at /usr) mounted over it. Host /usr is never needed:
// sources, the sysroot and outputs all live under the build tree.
//
// The bundle does not export its runtime classes, so they are re-exported
// from a generated sibling module (bundle text + one export line).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";


/** Directory holding the toolchain's node_modules (see fetch-wasm-toolchain.mjs). */
export function toolchainDir() {
  if (process.env.ROMDEV_WASM_TOOLCHAIN) return path.resolve(process.env.ROMDEV_WASM_TOOLCHAIN);
  const here = path.dirname(new URL(import.meta.url).pathname);
  const build = process.env.ROMDEV_BUILD_DIR ?? path.resolve(here, "../../build");
  return path.join(build, "wasm-toolchain");
}

let runtimePromise = null;

async function loadRuntime() {
  const bundle = path.join(toolchainDir(), "node_modules/@yowasp/clang/gen/bundle.js");
  if (!fs.existsSync(bundle)) throw new Error(`@yowasp/clang not found at ${bundle}; run scripts/wasm-emcc/fetch-wasm-toolchain.mjs`);
  const ext = bundle.replace(/bundle\.js$/, "bundle-romdev.mjs");
  const src = fs.readFileSync(bundle, "utf8");
  const extra = "\nexport { Environment as __Environment, Directory as __Directory, File as __File, instantiate as __instantiate, llvm_resources_exports as __resources, Descriptor as __Descriptor, WriteStream as __WriteStream };\n";
  if (!fs.existsSync(ext) || fs.readFileSync(ext, "utf8") !== src + extra) fs.writeFileSync(ext, src + extra);
  const m = await import(pathToFileURL(ext).href);
  // The stock runtime has no timestamps; llvm-objcopy/ar call set-times on
  // their outputs and fail with ENOSYS without it. A no-op keeps the host's
  // own mtime (the write just happened), which is what make wants anyway.
  for (const name of ["setTimes", "setTimesAt", "syncData", "sync"]) m.__Descriptor.prototype[name] ??= function () {};
  // The stock file WriteStream inherits OutputStream.checkWrite(), which
  // reports the stream closed, and grows the file by a full copy per write.
  m.__WriteStream.prototype.checkWrite = function () { return 1n << 20n; };
  const origWrite = m.__WriteStream.prototype.write;
  m.__WriteStream.prototype.write = function (contents) {
    if (typeof this.file.writeAt !== "function") return origWrite.call(this, contents);
    this.file.writeAt(Number(this.offset), contents);
    this.offset += BigInt(contents.length);
  };
  if (process.env.ROMDEV_LLVM_TRACE) {
    const P = m.__Descriptor.prototype;
    for (const name of Object.getOwnPropertyNames(P)) {
      if (name === "constructor" || typeof P[name] !== "function") continue;
      const orig = P[name];
      P[name] = function (...a) {
        try { const r = orig.apply(this, a); process.stderr.write(`[wasi] ${name}(${a.map((x) => typeof x === "string" ? x : typeof x === "bigint" ? String(x) : JSON.stringify(x)?.slice(0, 60)).join(", ")}) ok\n`); return r; }
        catch (e) { process.stderr.write(`[wasi] ${name}(${a.map((x) => typeof x === "string" ? x : String(x)).join(", ")}) THROW ${e}\n`); throw e; }
      };
    }
  }
  const fetchFile = async (url) => new Response(fs.readFileSync(url), { headers: { "content-type": String(url).endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } });
  const [modules, filesystem] = await Promise.all([m.__resources.modules(fetchFile), m.__resources.filesystem(fetchFile)]);
  return { m, modules, filesystem };
}

/** Build the disk-backed directory classes against the bundle's own File/Directory. */
function diskClasses(Directory, File, dirty) {
  const cache = new Map(); // abs path -> entry, so metadataHash ids stay stable within a run
  class DiskFile extends File {
    constructor(p, data) {
      super();
      this.path = p;
      this._data = data ?? null;
      this._dirty = data != null;
      if (this._dirty) dirty.add(this);
    }
    get data() {
      if (this._data === null) this._data = new Uint8Array(fs.readFileSync(this.path));
      return this._data;
    }
    set data(v) {
      if (this.path === undefined) return; // File's constructor assigning before we are set up
      this._data = v; this._dirty = true; dirty.add(this);
    }
    get size() { return this._data !== null ? this._data.length : fs.statSync(this.path).size; }
    writeAt(offset, contents) {
      const cur = this.data;
      const end = Math.max(cur.length, offset + contents.length);
      let buf = this._buf && this._buf.buffer === cur.buffer ? this._buf : null;
      if (!buf || buf.length < end) {
        buf = new Uint8Array(Math.max(end, (buf?.length ?? 0) * 2, 65536));
        buf.set(cur);
      }
      buf.set(contents, offset);
      this._buf = buf;
      this._data = buf.subarray(0, end);
      this._dirty = true; dirty.add(this);
    }
    flush() {
      if (this._dirty) { fs.writeFileSync(this.path, this._data); this._dirty = false; }
    }
  }
  const entryFor = (p, st) => {
    let e = cache.get(p);
    if (e) return e;
    e = st.isDirectory() ? new DiskDir(p) : new DiskFile(p);
    cache.set(p, e);
    return e;
  };
  let root = null;
  class DiskDir extends Directory {
    constructor(p, mounts = {}) {
      super({});
      this.path = p;
      const self = this;
      this.files = new Proxy({}, {
        getOwnPropertyDescriptor(_t, name) {
          if (typeof name !== "string") return undefined;
          const v = self.lookup(name);
          return v ? { value: v, writable: true, enumerable: true, configurable: true } : undefined;
        },
        has(_t, name) { return !!self.lookup(name); },
        get(_t, name) { return typeof name === "string" ? self.lookup(name) : undefined; },
        set(_t, name, value) { self.put(name, value); return true; },
        deleteProperty(_t, name) { self.remove(name); return true; },
        ownKeys() {
          const names = new Set(Object.keys(mounts));
          try { for (const n of fs.readdirSync(self.path)) names.add(n); } catch {}
          return [...names];
        },
      });
      this.mounts = mounts;
      if (p === "/") root = this;
    }
    // The bundle's traverse() treats ".." as a no-op, so "core/../x" would land
    // in core/x. Normalize against this directory and walk from the root.
    traverse(p, opts) {
      const abs = path.posix.normalize((p.startsWith("/") ? "" : this.path + "/") + p);
      const rel = abs.replace(/^\/+/, "");
      const { create = null, remove = false } = opts ?? {};
      const segs = rel === "" || rel === "." ? [] : rel.split("/");
      let entry = root;
      for (let i = 0; i < segs.length; i++) {
        if (entry instanceof File) throw "not-directory";
        const last = i === segs.length - 1, seg = segs[i];
        if (last && remove) { if (entry instanceof DiskDir) entry.remove(seg); else delete entry.files[seg]; return undefined; }
        let next = entry instanceof DiskDir ? entry.lookup(seg) : entry.files[seg];
        if (!next) {
          if (!(entry instanceof DiskDir)) {
            if (create === "directory" || (create !== null && !last)) next = entry.files[seg] = new Directory({});
            else if (create === "file") next = entry.files[seg] = new File(new Uint8Array());
            else if (create instanceof File || create instanceof Directory) next = entry.files[seg] = create;
            else throw "no-entry";
          } else {
            if (create === "directory" || (create !== null && !last)) entry.put(seg, new Directory({}));
            else if (create === "file") entry.put(seg, new File(new Uint8Array()));
            else if (create instanceof File || create instanceof Directory) entry.put(seg, create);
            else throw "no-entry";
            next = entry.lookup(seg);
          }
        } else if (last && (create instanceof File || create instanceof Directory)) {
          if (entry instanceof DiskDir) { entry.put(seg, create); next = entry.lookup(seg); } else next = entry.files[seg] = create;
        }
        entry = next;
      }
      return entry;
    }
    child(name) { return this.path === "/" ? "/" + name : this.path + "/" + name; }
    lookup(name) {
      if (Object.hasOwn(this.mounts, name)) return this.mounts[name];
      const p = this.child(name);
      const c = cache.get(p);
      if (c && (c instanceof DiskFile ? c._dirty : false)) return c;
      let st;
      try { st = fs.statSync(p); } catch { cache.delete(p); return undefined; }
      return entryFor(p, st);
    }
    put(name, value) {
      const p = this.child(name);
      if (value instanceof DiskFile || value instanceof DiskDir) {
        // rename: flush pending data at the old path, then move it
        if (value instanceof DiskFile) value.flush();
        fs.renameSync(value.path, p);
        cache.delete(value.path);
        value.path = p;
        cache.set(p, value);
      } else if (value instanceof File) {
        const f = new DiskFile(p, value.data);
        cache.set(p, f);
        f.flush();
      } else if (value instanceof Directory) {
        fs.mkdirSync(p, { recursive: true });
        cache.set(p, new DiskDir(p));
      } else throw new Error("unexpected entry");
    }
    remove(name) {
      const p = this.child(name);
      // An unlinked file must not be resurrected by the end-of-run flush.
      const gone = cache.get(p);
      if (gone instanceof DiskFile) { gone._dirty = false; dirty.delete(gone); }
      cache.delete(p);
      try {
        const st = fs.lstatSync(p);
        if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p);
      } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  }
  return { DiskDir, DiskFile };
}

function treeToDirectory(tree, Directory, File) {
  const files = {};
  for (const [k, v] of Object.entries(tree)) files[k] = (typeof v === "string" || v instanceof Uint8Array) ? new File(v) : treeToDirectory(v, Directory, File);
  return new Directory(files);
}

/**
 * Run one LLVM tool (argv[0] is the tool: clang, wasm-ld, ar, objcopy, ...).
 * Relative paths resolve against `/`, so pass absolute paths (clang: use
 * -working-directory). Returns the exit code; stdout/stderr go to callbacks.
 * @param {string[]} argv
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void, env?: Record<string,string>}} [opts]
 */
export async function runLLVMTool(argv, opts = {}) {
  runtimePromise ??= loadRuntime();
  const { m, modules, filesystem } = await runtimePromise;
  const dirty = new Set();
  const { DiskDir } = diskClasses(m.__Directory, m.__File, dirty);
  const env = new m.__Environment();
  env.args = ["yowasp-llvm", ...argv];
  env.vars = opts.env ?? {};
  const mounts = {};
  for (const [name, tree] of Object.entries(filesystem)) mounts[name] = treeToDirectory(tree, m.__Directory, m.__File);
  env.root = new DiskDir("/", mounts);
  const dec = new TextDecoder();
  const sink = (fn) => { let buf = ""; return (bytes) => { if (bytes === null) { if (buf) fn(buf); buf = ""; return; } buf += dec.decode(bytes, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { fn(buf.slice(0, i + 1)); buf = buf.slice(i + 1); } }; };
  env.stdout = sink(opts.stdout ?? ((s) => process.stdout.write(s)));
  env.stderr = sink(opts.stderr ?? ((s) => process.stderr.write(s)));
  env.stdin = null;
  let code = 0;
  try {
    const cmd = await m.__instantiate((f) => modules[f], { runtime: env.exports });
    try { cmd.run.run(); } catch (e) {
      if (typeof e?.code === "number" && e.constructor?.name === "Exit") code = e.code;
      else if (e?.constructor?.name === "ComponentError") code = 1;
      else throw e;
    }
  } finally {
    for (const f of dirty) f.flush();
    env.stdout(null); env.stderr(null);
  }
  return code;
}

/** Split one `clang -###` command line into argv (same rule the yowasp wrapper uses). */
function unquote(line) {
  return Array.from(line.matchAll(/ (?:([^ "]+)|"((?:[^"\\$]|\\["\\$])+)")/g), (mm) => mm[1] !== undefined ? mm[1] : mm[2].replaceAll(/\\["$\\]/g, (x) => x[1]));
}

/**
 * Run the clang DRIVER: WASI cannot spawn, so ask the driver for its job list
 * with -### and run each job (cc1, wasm-ld) in turn.
 * @param {string[]} argv  argv[0] = "clang" | "clang++"
 */
export async function runClangDriver(argv, opts = {}) {
  let out = "";
  const code = await runLLVMTool([argv[0], "-###", ...argv.slice(1)], { stdout: (s) => { out += s; }, stderr: (s) => { out += s; } });
  if (code !== 0) { (opts.stderr ?? ((s) => process.stderr.write(s)))(out); return code; }
  const jobs = [];
  for (const line of out.split("\n")) if (line.startsWith(' "')) { const a = unquote(line); if (a[0] === "") a.shift(); jobs.push(a); }
  if (argv.includes("-v")) (opts.stderr ?? ((s) => process.stderr.write(s)))(out);
  for (const job of jobs) {
    const c = await runLLVMTool(job, opts);
    if (c !== 0) return c;
  }
  return 0;
}
