// log.js — tiny leveled logger so the server is QUIET by default in prod.
//
// The per-call / per-session trace lines are invaluable while developing but
// are noise (and IO cost) in a published package. They're gated behind a
// verbosity switch for STDOUT — but every message is ALSO captured into an
// in-memory ring buffer regardless of verbosity, so you can pull recent
// activity as JSON from the /log HTTP endpoint without scraping stdout (or
// having had --verbose on). The /livestream socket.io stream remains the
// canonical live monitor; /log is the cheap "what just happened?" poll.
//
// Levels (low → high verbosity):
//   error  — always printed (to stderr)
//   info   — always printed (to stdout): startup banner, shutdown, fatals
//   debug  — printed ONLY when verbose: per-call traces, session lifecycle,
//            playtest/observer chatter
// All three are always recorded in the ring buffer.
//
// Enable debug stdout with any of:
//   --verbose                 (CLI flag)
//   ROMDEV_LOG=debug          (env; also accepts "verbose"/"trace")
//   ROMDEV_VERBOSE=1          (env)

function computeVerbose() {
  if (process.argv.slice(2).includes("--verbose")) return true;
  const lvl = (process.env.ROMDEV_LOG ?? "").toLowerCase();
  if (lvl === "debug" || lvl === "verbose" || lvl === "trace") return true;
  if (process.env.ROMDEV_VERBOSE && process.env.ROMDEV_VERBOSE !== "0") return true;
  return false;
}

// Resolved once at import. Server is a long-lived process; no need to re-check.
const VERBOSE = computeVerbose();

// Bounded FIFO ring buffer of recent log records. A long-running server emits
// unbounded log lines over its lifetime, so this MUST drop the oldest records
// to stay flat in memory — two caps guarantee that:
//   - RING_CAP   : max number of records kept (oldest evicted on overflow)
//   - MSG_CAP    : max chars per record (a giant stack/object can't bloat one)
// Sized so a whole multi-turn agent session — including build error logs, which
// can be several KB each — fits and stays diagnosable. Worst-case footprint ≈
// RING_CAP * MSG_CAP ≈ 5000 * 8 KB ≈ 40 MB, fixed. Override with
// ROMDEV_LOG_RING / ROMDEV_LOG_MSG_CAP if you need more/less.
const RING_CAP = Number(process.env.ROMDEV_LOG_RING) || 5000;
const MSG_CAP = Number(process.env.ROMDEV_LOG_MSG_CAP) || 8000;
/** @type {{t:number, level:string, msg:string}[]} */
const ring = [];

function record(level, args) {
  // Join args into one string the way console would, cheaply.
  let msg;
  try {
    msg = args.map((a) => (typeof a === "string" ? a : stringifyArg(a))).join(" ");
  } catch {
    msg = String(args[0]);
  }
  // Truncate oversized single messages so one record can't leak memory.
  if (msg.length > MSG_CAP) msg = msg.slice(0, MSG_CAP) + `…(+${msg.length - MSG_CAP} chars)`;
  ring.push({ t: Date.now(), level, msg });
  // Drop oldest so the queue length never exceeds the cap.
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
}

function stringifyArg(a) {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export const log = {
  /** Whether debug-level output is printed to stdout. */
  verbose: VERBOSE,
  /** Always printed. Startup banner, shutdown notices, anything a user must see. */
  info(...args) { record("info", args); console.log(...args); },
  /** Always printed, on stderr. Real failures. */
  error(...args) { record("error", args); console.error(...args); },
  /** Printed only in verbose mode; always recorded in the ring buffer. */
  debug(...args) { record("debug", args); if (VERBOSE) console.log(...args); },
  /**
   * Most-recent log records (oldest → newest), newest-last. Pass a limit to cap
   * how many you get back (default all in the buffer, max RING_CAP).
   * @param {number} [limit]
   * @returns {{t:number, level:string, msg:string}[]}
   */
  recent(limit) {
    if (!limit || limit >= ring.length) return ring.slice();
    return ring.slice(ring.length - limit);
  },
};
