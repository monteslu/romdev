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
