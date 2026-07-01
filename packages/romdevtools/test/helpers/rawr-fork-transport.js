// rawr transports for a forked child PROCESS (child_process.fork gives an IPC channel:
// child.send() / process.send() + 'message' events). rawr speaks JSON-RPC over any
// EventEmitter with a `.send`, so these are thin adapters.
//
// Why a child process (not a worker thread): rungame's jsgame session loads @kmamal/sdl,
// which refuses to run off the main thread ("can only be used in the main thread"). A
// forked child is a real process with its own main thread, so SDL works there. Running
// the session in the child + calling it over rawr keeps the MAIN test process clean —
// killing the child disposes rungame's leaked SDL/audio/timer handles without a global
// --test-force-exit (which would mask real leaks elsewhere).

import { EventEmitter } from "node:events";

/** Transport for the PARENT side (wraps a forked ChildProcess). */
export function parentTransport(child) {
  const emitter = new EventEmitter();
  child.on("message", (data) => {
    if (data && (data.method || (data.id && ("result" in data || "error" in data)))) {
      emitter.emit("rpc", data);
    }
  });
  emitter.send = (msg) => child.send(msg);
  return emitter;
}

/** Transport for the CHILD side (wraps process itself). */
export function childTransport(proc) {
  const emitter = new EventEmitter();
  proc.on("message", (data) => {
    if (data && (data.method || (data.id && ("result" in data || "error" in data)))) {
      emitter.emit("rpc", data);
    }
  });
  emitter.send = (msg) => proc.send(msg);
  return emitter;
}
