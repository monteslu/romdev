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
  // Serve the static SPA.
  app.get("/livestream", (req, res) => {
    res.sendFile(path.join(__dirname, "livestream.html"));
  });
  app.get("/livestream/", (req, res) => {
    res.sendFile(path.join(__dirname, "livestream.html"));
  });

  // Socket.io on the primary server, then ATTACHED to every other listener too
  // (io.attach is additive). No auth — loopback only.
  const io = new SocketIOServer(servers[0], {
    cors: { origin: "*" },
  });
  for (const s of servers.slice(1)) io.attach(s, { cors: { origin: "*" } });

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
