// The cart output ring buffer.
//
// wasmcart's CartHost writes every wc_log line and every cart printf straight
// to process.stderr prefixed `[cart] `, one or two lines PER FRAME. Echoed to
// the server log that came to 58 MB in a day and buried every actual server
// event -- including, on 2026-08-19, the fact that the process had been
// OOM-killed: the log just stopped mid-boot, because nothing server-level had
// been written for hours.
//
// So the lines are filtered out of the log by default and kept here instead,
// where a cart being debugged can still get at them via
// catalog({op:'status'}). ROMDEV_LOG_CART=1 restores the full echo.
//
// This lives in its own module rather than in server.js because tools/index.js
// reads it, server.js imports tools/index.js, and importing server.js for a
// getter would run its top level -- which binds the port. A one-line import
// would have turned a status field into "port already in use".

const MAX = 200;

/** @type {string[]} */
const ring = [];

/** Record one cart output line (already stripped of its trailing newline). */
export function pushCartLine(line) {
  if (!line) return;
  ring.push(line);
  if (ring.length > MAX) ring.shift();
}

/** The buffered cart output, oldest first. */
export function recentCartLog() {
  return ring.slice();
}

/**
 * Keep `[cart] ` lines out of this process's stderr and in the ring above.
 * The server calls it at start, and so does every host runner process (each
 * session's cart then has its own ring, read by that session's status).
 * ROMDEV_LOG_CART=1 leaves stderr unfiltered.
 */
export function installCartLogFilter() {
  if (process.env.ROMDEV_LOG_CART === "1") return; // opt back in, unfiltered
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    try {
      const text = typeof chunk === "string" ? chunk : chunk?.toString?.("utf8") ?? "";
      if (text.startsWith("[cart] ")) {
        for (const line of text.split("\n")) pushCartLine(line);
        // Swallow: tell the caller we wrote it. A callback-style write still
        // needs its callback, or a writer awaiting drain would hang.
        const cb = rest.find((a) => typeof a === "function");
        if (cb) cb();
        return true;
      }
    } catch { /* fall through to a real write */ }
    return realWrite(chunk, ...rest);
  };
}
