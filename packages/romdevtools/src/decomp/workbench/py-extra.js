// py-extra.js - error classes the comparison modules raise, named after the
// failure categories the command handlers report as `error: ...` (exit 2).
//
// Plain JS ESM + JSDoc.

/** An input/output failure (missing file, unusable tool). */
export class OSError extends Error { constructor(message) { super(message); this.name = "OSError"; } }
export class FileNotFoundError extends OSError { constructor(message) { super(message); this.name = "FileNotFoundError"; } }
/** A process or selection failure the command reports verbatim. */
export class RuntimeError extends Error { constructor(message) { super(message); this.name = "RuntimeError"; } }

/** True for the error kinds a comparison command reports rather than crashes on. */
export function isReportedError(e) {
  return e instanceof OSError || e instanceof RuntimeError || e?.name === "ValueError" || (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code));
}
