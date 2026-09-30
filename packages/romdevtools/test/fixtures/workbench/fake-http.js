// An offline transport double for the polite HTTP client: a queue of scripted
// answers plus the record of what was actually sent, so a test can assert on
// headers and on the pauses a client took. Nothing here opens a socket.
import { gzipSync } from "node:zlib";
import { TransientFailure } from "../../../src/decomp/workbench/http-client.js";

export class Answer {
  constructor({ status = 200, body = "", headers = {}, unreachable = null } = {}) {
    Object.assign(this, { status, body: Buffer.from(body), headers, unreachable });
  }
}

export const jsonAnswer = (payload, { status = 200 } = {}) => new Answer({ status, body: Buffer.from(payload, "utf8"), headers: { "Content-Type": "application/json" } });
export const htmlAnswer = (status, body = "<!doctype html><html>blocked</html>") => new Answer({ status, body, headers: { "Content-Type": "text/html; charset=utf-8" } });
export const gzip = (s) => gzipSync(Buffer.from(s));

/** Answer each request from a script, recording what was asked. */
export function fakeOpener(...answers) {
  const queue = [...answers];
  const opener = async (request, timeout) => {
    opener.requests.push(request);
    opener.timeout = timeout;
    if (!queue.length) throw new Error(`unscripted request: ${request.url}`);
    const answer = queue.shift();
    if (answer.unreachable !== null) throw new TransientFailure(answer.unreachable);
    return { status: answer.status, headers: answer.headers, body: answer.body };
  };
  opener.requests = [];
  Object.defineProperty(opener, "urls", { get: () => opener.requests.map((r) => r.url) });
  return opener;
}

/** A sleep that records instead of waiting. */
export function recordedSleep() {
  const sleep = async (seconds) => { sleep.waits.push(seconds); };
  sleep.waits = [];
  return sleep;
}
