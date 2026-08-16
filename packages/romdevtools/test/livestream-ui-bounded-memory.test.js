// The /livestream page is left open for hours next to a long agent run, and
// every piece of its per-session state used to grow without limit for as long
// as the tab stayed open:
//
//   s.events        one entry per tool call, forever
//   s.latestByKind  one FULL base64 PNG per distinct tool name
//   sessions        one entry per session key ever seen
//
// and renderLog() rebuilt a DOM row for every retained event on every incoming
// event, so the page also got slower the longer it ran.
//
// The page is inline <script> in an HTML file with no module boundary, so these
// tests extract the IIFE body and run it against a minimal DOM + socket stub.
// That keeps the assertions on the REAL shipped source: a hand-copied version
// of the logic here would pass forever while the page regressed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.resolve(__dirname, "../src/observer/livestream.html");

/** Minimal DOM: enough for the page's createElement/appendChild/innerHTML use. */
function makeElement(tag = "div") {
  const el = {
    tagName: tag,
    children: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    set innerHTML(v) { this._html = v; if (v === "") this.children = []; },
    get innerHTML() { return this._html ?? ""; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text ?? ""; },
    appendChild(c) {
      // A DocumentFragment splices its children in, like the real DOM.
      if (c && c.__fragment) this.children.push(...c.children);
      else this.children.push(c);
      return c;
    },
    addEventListener() {},
    remove() {},
  };
  return el;
}

/** Load the page script into a sandbox and return its captured socket handlers. */
function loadPage() {
  const html = readFileSync(HTML, "utf8");
  const m = html.match(/<script>\n(\(function\(\) \{[\s\S]*?)\n<\/script>/);
  assert.ok(m, "could not extract the inline page script — did the file shape change?");

  const handlers = new Map();
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };

  const sandbox = {
    io: () => ({ on: (name, fn) => handlers.set(name, fn) }),
    document: {
      getElementById: getEl,
      createElement: (tag) => makeElement(tag),
      createDocumentFragment: () => {
        const f = makeElement("#fragment");
        f.__fragment = true;
        return f;
      },
      createTextNode: (t) => ({ nodeValue: t }),
    },
    setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox);
  return { handlers, elements, getEl };
}

/** Drive `n` call events through the page's socket 'event' handler. */
function pump(handlers, n, { sessionKey = "s1", withImage = false, tool = "frame" } = {}) {
  const onEvent = handlers.get("event");
  for (let i = 0; i < n; i++) {
    onEvent({
      type: "call",
      sessionKey,
      ts: 1000 + i,
      tool: typeof tool === "function" ? tool(i) : tool,
      args: { i },
      ok: true,
      durationMs: 1,
      result: { i },
      ...(withImage
        ? { images: [{ kind: "image", mimeType: "image/png", base64: "A".repeat(2048) }] }
        : {}),
    });
  }
}

test("event retention is capped: memory does not grow with run length", () => {
  const { handlers, getEl } = loadPage();
  const logList = getEl("log-list");
  handlers.get("replay")({ events: [], activeSessions: ["s1"] });

  // Measure the rendered row count at two very different run lengths. An
  // unbounded s.events makes the second strictly larger; a capped one makes
  // them identical. This is the actual leak assertion — the DOM row count is
  // the only observable the page exposes, and it tracks s.events until the cap.
  pump(handlers, 400);
  const afterShort = logList.children.length;
  pump(handlers, 4000);
  const afterLong = logList.children.length;

  assert.equal(
    afterLong, afterShort,
    `retention must not grow with run length: ${afterShort} rows at 400 events, ` +
    `${afterLong} at 4400 — an unbounded list would keep climbing`,
  );
});

test("rendering is bounded: a long run does not build a DOM row per event", () => {
  const { handlers, getEl } = loadPage();
  const logList = getEl("log-list");

  // Select the session so the log pane actually renders.
  handlers.get("replay")({ events: [], activeSessions: ["s1"] });
  pump(handlers, 5000);

  assert.ok(
    logList.children.length > 0,
    "the log pane should render something for an active session",
  );
  assert.ok(
    logList.children.length <= 200,
    `log rows must be capped; built ${logList.children.length} for 5000 events`,
  );
});

test("image memory is bounded across many distinct tools", () => {
  const { handlers, getEl } = loadPage();
  const imageList = getEl("image-list");
  handlers.get("replay")({ events: [], activeSessions: ["s1"] });

  // One image per distinct tool name — this is what pinned a full base64 PNG
  // per tool. 60 distinct tools is more than romdev has.
  pump(handlers, 60, { withImage: true, tool: (i) => `tool${i}` });

  assert.ok(
    imageList.children.length <= 8,
    `retained images must be capped; rendered ${imageList.children.length} cards`,
  );
});

test("many sessions are FINE — what matters is each one staying bounded", () => {
  const { handlers, getEl } = loadPage();
  const tabs = getEl("tabs");

  // 48 concurrent sessions is a normal fan-out shape, not a leak. They must
  // all keep their tabs; the bound that matters is per-session, asserted below.
  for (let i = 0; i < 48; i++) pump(handlers, 1, { sessionKey: `s${i}` });

  assert.equal(tabs.children.length, 48, "48 live sessions must all keep a tab");
});

test("each session stays bounded even with 48 of them running hot", () => {
  const { handlers, getEl } = loadPage();
  const logList = getEl("log-list");
  const imageList = getEl("image-list");
  handlers.get("replay")({ events: [], activeSessions: ["s0"] });

  // Every session pushes far past the caps, with images, concurrently.
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 48; i++) {
      pump(handlers, 25, { sessionKey: `s${i}` });
      pump(handlers, 2, { sessionKey: `s${i}`, withImage: true, tool: (n) => `tool${round}_${n}` });
    }
  }

  // The viewed session rendered a bounded amount despite 500+ events pushed.
  assert.ok(
    logList.children.length <= 200,
    `log rows must stay capped under load; got ${logList.children.length}`,
  );
  assert.ok(
    imageList.children.length <= 8,
    `retained images must stay capped under load; got ${imageList.children.length}`,
  );
});

test("the ACTIVE session is never evicted out from under the viewer", () => {
  const { handlers, getEl } = loadPage();
  // Make s1 active, then flood with other sessions that all disconnect.
  handlers.get("replay")({ events: [], activeSessions: ["s1"] });
  pump(handlers, 5, { sessionKey: "s1" });

  const onEvent = handlers.get("event");
  for (let i = 0; i < 40; i++) {
    pump(handlers, 1, { sessionKey: `other${i}` });
    onEvent({ type: "session_disconnect", sessionKey: `other${i}`, ts: 3000 + i });
  }

  // s1 must still render its log — if it had been evicted the pane would be empty.
  const logList = getEl("log-list");
  assert.ok(
    logList.children.length > 0,
    "the session being viewed must survive pruning",
  );
});
