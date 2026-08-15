// observer/server.js — attach the /livestream socket.io endpoint + static
// HTML to an existing express + node:http server.
//
// Wire from src/mcp/server.js after building the express app + creating
// the httpServer(s):
//
//   import { attachObserver } from "../observer/server.js";
//   attachObserver(app, httpServer, ...extraServers);
//
// Browser opens http://localhost:7331/livestream (or 127.0.0.1) and gets the
// SPA. Socket.io is attached to EVERY listener on the default /socket.io path —
// the server binds both the IPv4 (127.0.0.1) and IPv6 (::1) loopback stacks,
// and `localhost` resolves to either depending on the OS. Attaching socket.io
// to only the primary listener 404'd the /socket.io requests whenever the
// browser landed on the other stack (the classic "works on 127.0.0.1, 404s on
// localhost" bug).

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { Server as SocketIOServer } from "socket.io";
import { observer } from "./bus.js";
import { log } from "../mcp/log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @param {import("express").Express} app
 * @param {...import("node:http").Server} httpServers one or more http.Server
 *   listeners (e.g. the IPv4 + IPv6 loopback servers). socket.io is attached to
 *   ALL of them so /livestream + /socket.io work no matter which stack the
 *   browser's `localhost` resolves to.
 */
export function attachObserver(app, ...httpServers) {
  const servers = httpServers.filter(Boolean);
  // Serve the static SPA. Read+send the HTML directly rather than res.sendFile
  // — sendFile's internal `send` throws NotFoundError on the absolute package
  // path under npm/npx installs (404 even though the file is right there).
  // Inject the package version (the same single-source-of-truth read the MCP
  // serverInfo uses) so the page always shows the running server's version —
  // never hardcoded, never drifting from the published package.
  const version = (() => {
    try {
      return JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8")).version;
    } catch {
      return "";
    }
  })();
  const html = readFileSync(path.join(__dirname, "livestream.html"), "utf8")
    .replace("__ROMDEV_VERSION__", version ? `v${version}` : "");
  const serveHtml = (req, res) => res.type("html").send(html);
  app.get("/livestream", serveHtml);
  app.get("/livestream/", serveHtml);

  // Socket.io on the primary server, then ATTACHED to every other listener too
  // (io.attach is additive). No auth — loopback only.
  // maxHttpBufferSize is a STATED choice, not socket.io's silent 1MB default.
  // A live `event` carrying one full-size composite PNG can exceed 1MB on its
  // own, and the default doesn't error visibly — it closes the connection, the
  // client reconnects, and the page looks like it's hanging. The ring is
  // byte-bounded (bus.js RING_MAX_BYTES) so replay stays well under this;
  // loopback-only, so a generous ceiling costs nothing.
  const ioOpts = { cors: { origin: "*" }, maxHttpBufferSize: 32 * 1024 * 1024 };
  const io = new SocketIOServer(servers[0], ioOpts);
  for (const s of servers.slice(1)) io.attach(s, ioOpts);

  io.on("connection", (socket) => {
    // On connect, replay the ring buffer so the client sees recent
    // activity AND get the current session list so tabs render immediately.
    socket.emit("replay", {
      events: observer.replay(),
      activeSessions: observer.activeSessions(),
    });
  });

  // Wire the observer event stream into every connected client.
  observer.on("event", (event) => {
    io.emit("event", event);
  });

  log.debug("[observer] /livestream wired (socket.io on the same port)");
}
