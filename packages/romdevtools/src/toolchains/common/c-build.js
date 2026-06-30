// Shared C-SDK build-pipeline helper (0.81.0). The gba-c / genesis-c / mips-c / sh-c
// builders all walk the SAME spine — compile each .c (cc1 → as), assemble raw .s,
// assemble a crt0, link, optionally objcopy, finalize — and at EVERY stage repeat the
// identical 5-part dance:
//
//     const r = await runX(...);
//     log += `--- stage ---\n${r.log || "(ok)"}\n`;
//     if (r.exitCode !== 0 || !r.<output>)
//       return { ok: false, binary: null, log, exitCode: r.exitCode || 1, stage, ...(r.crash ? { crash } : {}) };
//
// That `if (...) return { ok:false, ... }` line appeared ~73 times across the 5 builders.
// CBuild owns it: each builder makes one `new CBuild()`, calls `.stage(name, () => runX(...), pick)`,
// and the helper accumulates the log + THROWS a BuildError on any failure. The builder
// wraps its body in try/catch and turns a BuildError into the same `{ ok:false, ... }` shape
// it returned before — so the public contract is byte-for-byte unchanged, the boilerplate
// is gone, and each builder keeps only its genuinely-per-platform wiring (which crt0, which
// libs, finalize). No behavior change.

/**
 * Thrown by CBuild.stage() when a stage fails. Carries everything the builder's
 * error return needs. The builder catches it and maps to its result object.
 */
export class BuildError extends Error {
  /** @param {{stage:string, exitCode:number, log:string, crash?:any}} info */
  constructor(info) {
    super(`build failed at stage: ${info.stage}`);
    this.name = "BuildError";
    this.stage = info.stage;
    this.exitCode = info.exitCode;
    this.log = info.log;
    if (info.crash) this.crash = info.crash;
  }
  /**
   * The canonical failure result the GCC/tcc C-SDK builders return (includes
   * `ok: false`). Pass extra fields (e.g. a platform-specific `{ runtime }`) to merge.
   * @param {Record<string, any>} [extra]
   */
  toResult(extra = {}) {
    return { ok: false, ...this.fields(extra) };
  }

  /**
   * The failure fields WITHOUT a forced `ok` — for builders (cc65/sdcc) whose
   * lower layer returns `{ binary, log, exitCode, stage }` and lets the caller
   * (index.js) add `ok`. Same { binary:null, log, exitCode, stage, crash? } core
   * + any `extra` (e.g. sdcc's `failedTU` / `compiledOK`). Note: crash is only
   * spread when present (cc65/sdcc historically never carried it — pass nothing).
   * @param {Record<string, any>} [extra]
   */
  fields(extra = {}) {
    return {
      binary: null,
      log: this.log,
      exitCode: this.exitCode,
      stage: this.stage,
      ...(this.crash ? { crash: this.crash } : {}),
      ...extra,
    };
  }
}

/**
 * A build-log accumulator + stage runner. One per build.
 *
 * Usage:
 *   const cb = new CBuild();
 *   const cc = await cb.stage(`cc1 (${name})`, () => runCc1x({...}), r => r.asmSource);
 *   // cc is the full run result; cb.log has the accumulated log.
 *   // a failure THROWS BuildError — wrap the build body in try/catch.
 */
export class CBuild {
  constructor() {
    /** @type {string} accumulated build log */
    this.log = "";
  }

  /**
   * Run one toolchain stage, append its log, and throw BuildError on failure.
   *
   * @template T
   * @param {string} name  stage label — the failure `stage` field AND, by default,
   *                       the log header. Most builders use one string for both.
   * @param {() => Promise<T>} run  the toolchain call (returns {log, exitCode, crash?, ...output})
   * @param {(r: T) => any} pick  selects the stage's required output (e.g. r => r.object);
   *                              a falsy result is treated as failure even if exitCode is 0
   * @param {{logName?:string}} [opts]  `logName` overrides ONLY the log header when a
   *                       builder historically logged a label that differs from the
   *                       failure `stage` string (e.g. log "as (x → .o)" / stage "as (x)").
   * @returns {Promise<T>} the full run result (on success)
   */
  async stage(name, run, pick, opts = {}) {
    const r = await run();
    this.log += `--- ${opts.logName ?? name} ---\n${r.log || "(ok)"}\n`;
    if (r.exitCode !== 0 || !pick(r)) {
      throw new BuildError({
        stage: name,
        exitCode: r.exitCode || 1,
        log: this.log,
        crash: r.crash,
      });
    }
    return r;
  }

  /** Append a freeform note to the log (e.g. a sub-step that isn't a toolchain stage). */
  note(text) {
    this.log += text.endsWith("\n") ? text : text + "\n";
  }
}
