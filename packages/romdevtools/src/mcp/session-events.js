// Session end, as an event.
//
// `host({op:'shutdown'})` is the tool layer saying "this session is done with
// its emulator" -- and until now that was ALL it said. The HTTP route keeps a
// per-session tool registry (~20 MB of zod schemas and handler closures,
// measured) and a livestream entry, and neither learned about the shutdown:
// both sat until the 30-minute idle reaper. A suite that opens ~53 sessions
// per run and dutifully shuts every one down still left ~1 GB of registries
// and a livestream full of ghosts for half an hour. The agent was cleaning up
// correctly against an API that had no way to say "and forget the session".
//
// The tool layer cannot reach the HTTP session map directly -- routes.js owns
// it inside mountHttpToolRoutes' closure, and importing the tool layer from
// there already happens the other way around. So: a one-event bus. The
// shutdown case emits; whoever owns per-session state subscribes.
//
// Ending a session is NOT destructive to the caller: the next call with the
// same x-romdev-session simply builds a fresh session record (that is how the
// first call worked, too), and `lastMedia` breadcrumbs live in state.js maps
// that survive independently.

/** @type {Set<(sessionKey: string) => void>} */
const listeners = new Set();

/** Subscribe to session-end. Returns an unsubscribe function. */
export function onSessionEnd(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Announce that a session declared itself done (host shutdown, primary slot). */
export function emitSessionEnd(sessionKey) {
  for (const fn of listeners) {
    try { fn(sessionKey); } catch { /* one bad listener must not stop the rest */ }
  }
}
