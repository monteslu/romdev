import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.resolve(__dirname, "../src/observer/livestream.html");

// The livestream connects WEBSOCKET FIRST, with polling only as a fallback.
//
// socket.io's default does the opposite: it opens on HTTP long-polling and
// upgrades afterwards. That default costs THREE sequential round trips before
// any content arrives -- GET(open) -> POST(40) -> GET(data, which carries the
// replay) -- and the replay body is base64-inflated on the way. On loopback
// each leg is ~1.5ms so the whole thing is invisible, which is exactly why it
// shipped: the observer was written assuming loopback. Over a network it is
// 3x RTT before the "connected" label even flips, and every later server
// message needs a fresh request cycle instead of a push.
//
// Asserted on the SHIPPED HTML rather than a copy, and asserted on the option
// itself rather than on behaviour, because the test harness's `io` stub
// ignores its arguments -- a silent revert to bare `io()` would otherwise keep
// every other livestream test green.
test("livestream connects websocket-first, not on socket.io's polling default", () => {
  const html = readFileSync(HTML, "utf8");
  const m = html.match(/const socket = io\(([^)]*)\)/);
  assert.ok(m, "could not find the io() call — did livestream.html change shape?");
  const args = m[1].trim();
  assert.notEqual(args, "", "bare io() reinstates socket.io's polling-first default");
  const order = [...args.matchAll(/"(websocket|polling)"/g)].map((x) => x[1]);
  assert.deepEqual(order, ["websocket", "polling"],
    'transports must be ["websocket", "polling"] — websocket first, polling kept as a fallback ' +
    "so a proxy that blocks websocket still gets a (slow) livestream rather than none");
});
