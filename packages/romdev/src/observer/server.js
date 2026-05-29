// observer/server.js — attach the /livestream socket.io endpoint + static
// HTML to an existing express + node:http server.
//
// Wire from src/mcp/server.js after building the express app + creating
// the httpServer:
//
//   import { attachObserver } from "../observer/server.js";
//   attachObserver(app, httpServer);
//
// Browser opens http://127.0.0.1:7331/livestream and gets the SPA.
// Socket.io binds to the same httpServer on the default /socket.io path.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { Server as SocketIOServer } from "socket.io";
import { observer } from "./bus.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @param {import("express").Express} app
 * @param {import("node:http").Server} httpServer
 */
export function attachObserver(app, httpServer) {
  // Serve the static SPA.
  app.get("/livestream", (req, res) => {
    res.sendFile(path.join(__dirname, "livestream.html"));
  });
  app.get("/livestream/", (req, res) => {
    res.sendFile(path.join(__dirname, "livestream.html"));
  });

  // Socket.io on the same httpServer. No auth — loopback only.
  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*" },
  });

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

  console.log("[observer] /livestream wired (socket.io on the same port)");
}
