// http-client.js - a small, polite, explicitly invoked HTTP client for the
// public decomp.me API. Offline-first: only fetch-scratch and
// public-match-check use it. Requests are serialized, identified by name
// (the User-Agent names this package and version), timed out, retried at most
// once, and a refusal is reported as a refusal with the offline route out.
// The transport is injected (`opener`), so tests never touch a network.
//
// Plain JS ESM + JSDoc.

import zlib from "node:zlib";
import { formatG } from "./globalcolor.js";
import { strRepr } from "./py.js";

export const WORKBENCH_VERSION = "0.8.0";
export const PROJECT_URL = "https://github.com/akratch/n64-decomp-workbench";
export const USER_AGENT = `n64-decomp-workbench/${WORKBENCH_VERSION} (+${PROJECT_URL})`;
export const BROWSER_SHAPED_HEADERS = Object.freeze({ "Accept-Language": "en-US,en;q=0.9", "Referer": "https://decomp.me/" });
export const ACCEPT_ENCODING = "gzip, deflate";
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const MAX_RETRY_AFTER_SECONDS = 30.0;
export const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** A request could not be completed. The message is user-facing. */
export class NetworkError extends Error { constructor(m) { super(m); this.name = "NetworkError"; } }
export class RequestRefused extends NetworkError { constructor(m) { super(m); this.name = "RequestRefused"; } }
export class RateLimited extends NetworkError { constructor(m) { super(m); this.name = "RateLimited"; } }
export class ResourceNotFound extends NetworkError { constructor(m) { super(m); this.name = "ResourceNotFound"; } }

/**
 * The transport failed before any status arrived. An opener throws this (or
 * any error, which is treated the same way) for a connection failure.
 */
export class TransientFailure extends Error {
  constructor(reason, cause = null) { super(reason); this.reason = reason; this.cause = cause; }
}

/** One completed exchange, whatever its status. */
export class HttpResponse {
  constructor({ url, status, body, headers = {} }) { Object.assign(this, { url, status, body: Buffer.from(body ?? []), headers }); Object.freeze(this); }
  get content_type() { return String(headerGet(this.headers, "Content-Type") ?? "").split(";")[0].trim().toLowerCase(); }
  text(limit = null) {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(this.body);
    return limit === null ? decoded : [...decoded].slice(0, limit).join("");
  }
  looksLikeAWebPage() {
    if (this.content_type === "text/html") return true;
    const head = this.body.toString("latin1").replace(/^[\s\x0b]+/, "").slice(0, 15).toLowerCase();
    return head.startsWith("<!doctype") || head.startsWith("<html");
  }
}

/** Header lookup with the exact spelling first, then case-insensitively. */
function headerGet(headers, name) {
  if (name in headers) return headers[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function decodeBody(raw, encoding) {
  const normalized = String(encoding ?? "").trim().toLowerCase();
  if (normalized === "" || normalized === "identity") return raw;
  try {
    if (normalized === "gzip") return zlib.gunzipSync(raw);
    if (normalized === "deflate" || normalized === "zlib") {
      try { return zlib.inflateSync(raw); } catch { return zlib.inflateRawSync(raw); }
    }
  } catch (e) {
    throw new NetworkError(`the server sent a ${normalized} response the client could not decode: ${e.message}`);
  }
  throw new NetworkError(`unsupported response content-encoding: ${encoding}`);
}

function boundedBody(body, url) {
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new NetworkError(`response from ${url} exceeds the ${Math.floor(MAX_RESPONSE_BYTES / (1024 * 1024))} MiB limit`);
  }
  return body;
}

function retryAfterSeconds(headers) {
  const raw = headerGet(headers, "Retry-After") ?? headerGet(headers, "retry-after");
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$|^[-+]?(inf|infinity|nan)$/i.test(s)) return null;
  const v = /inf/i.test(s) ? (s.startsWith("-") ? -Infinity : Infinity) : Number(s);
  if (Number.isNaN(v)) return null;
  return Math.max(0, v);
}

/** Why a fetch failed, in the words a socket error uses. */
function transportReason(e) {
  const c = e?.cause ?? e;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timed out";
  const codes = { ECONNREFUSED: "[Errno 111] Connection refused", ENOTFOUND: "[Errno -2] Name or service not known",
    ECONNRESET: "[Errno 104] Connection reset by peer", EHOSTUNREACH: "[Errno 113] No route to host", ETIMEDOUT: "timed out" };
  return codes[c?.code] ?? String(c?.message ?? c);
}

/**
 * The default transport: node fetch. It answers every status (a refusal is
 * a response, not an exception) and throws TransientFailure when no status
 * arrived. fetch already decodes compressed bodies, so the encoding header
 * is dropped from what it returns.
 */
export async function fetchOpener(request, timeout) {
  let res;
  try {
    res = await fetch(request.url, { method: request.method ?? "GET", headers: request.headers, redirect: "follow", signal: AbortSignal.timeout(Math.max(1, timeout * 1000)) });
  } catch (e) {
    throw new TransientFailure(transportReason(e), e);
  }
  const headers = {};
  for (const [k, v] of res.headers) if (k.toLowerCase() !== "content-encoding") headers[k.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase())] = v;
  let body;
  try { body = Buffer.from(await res.arrayBuffer()); } catch (e) { throw new TransientFailure(transportReason(e), e); }
  return { status: res.status, headers, body };
}

const defaultSleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

/** Serialized, identified, timed-out, retry-once GETs. */
export class PoliteClient {
  constructor({ opener = null, timeout = 30.0, retries = 1, backoff_seconds = 2.0, sleep = defaultSleep, user_agent = USER_AGENT, contact = null } = {}) {
    this._opener = opener ?? fetchOpener;
    this._timeout = timeout;
    this._retries = Math.max(0, retries);
    this._backoff = Math.max(0, backoff_seconds);
    this._sleep = sleep;
    this._user_agent = contact ? `${user_agent} contact:${contact}` : user_agent;
  }

  get user_agent() { return this._user_agent; }

  /** The exact header set a request will carry. */
  headersFor(accept) {
    return { "User-Agent": this._user_agent, "Accept": accept, "Accept-Encoding": ACCEPT_ENCODING, ...BROWSER_SHAPED_HEADERS };
  }

  /** Fetch `url`, raising a user-facing error for anything but success. */
  async get(url, { accept = "application/json" } = {}) {
    let attempt = 0;
    for (;;) {
      let response;
      try {
        response = await this._attempt(url, { accept });
      } catch (e) {
        if (!(e instanceof TransientFailure)) throw e;
        if (attempt >= this._retries) {
          throw new NetworkError(`could not reach ${url}: ${e.reason}. The workbench works offline; download the file in a browser and pass the local path instead.`);
        }
        await this._sleep(this._backoff * (attempt + 1));
        attempt += 1;
        continue;
      }
      if (response.status === 200) return response;
      if (RETRYABLE_STATUSES.has(response.status) && attempt < this._retries) {
        await this._wait(response, { attempt, url });
        attempt += 1;
        continue;
      }
      throw this._failure(response);
    }
  }

  /** Fetch and parse one JSON document, naming what arrived instead. */
  async getJson(url) {
    const response = await this.get(url, { accept: "application/json" });
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      return JSON.parse(text);
    } catch (e) {
      const preview = response.text(200).replace(/\n/g, " ").trim();
      const reason = e instanceof SyntaxError ? jsonErrorText(text ?? "") : `'utf-8' codec can't decode bytes: ${e.message}`;
      throw new NetworkError(`${url} did not answer with JSON (${reason}). The first bytes were: ${strRepr(preview)}. If that looks like a web page, the API path may have moved; check it in a browser.`);
    }
  }

  async _attempt(url, { accept }) {
    const request = { url, headers: this.headersFor(accept), method: "GET" };
    let raw;
    try {
      raw = await this._opener(request, this._timeout);
    } catch (e) {
      if (e instanceof TransientFailure) throw e;
      if (e instanceof NetworkError) throw e;
      throw new TransientFailure(transportReason(e), e);
    }
    const headers = raw.headers ?? {};
    const body = decodeBody(boundedBody(Buffer.from(raw.body ?? []), url), headerGet(headers, "Content-Encoding") ?? "");
    const status = raw.status ?? 200;
    return new HttpResponse({ url, status: Number(status), body, headers });
  }

  async _wait(response, { attempt, url }) {
    const requested = retryAfterSeconds(response.headers);
    if (requested !== null && requested > MAX_RETRY_AFTER_SECONDS) {
      throw new RateLimited(`${url} is rate limiting this client and asked for ${formatG(requested)} seconds. Nothing was fetched. Re-run the command after that wait; it is a volunteer-run server and the request is not worth working around.`);
    }
    await this._sleep(requested !== null ? requested : this._backoff * (attempt + 1));
  }

  _failure(response) {
    const { url, status } = response;
    if (status === 404) return new ResourceNotFound(`${url} does not exist (HTTP 404). Check the slug or search term; a scratch can also be deleted by its owner.`);
    if (status === 401 || status === 403) {
      const interstitial = response.looksLikeAWebPage() ? " and answered with a web page rather than the API document" : "";
      return new RequestRefused(`${url} refused this request (HTTP ${status})${interstitial}.\n`
        + `The workbench sends a User-Agent naming itself and its version (${this._user_agent}) plus the ordinary browser `
        + "headers, and it will not imitate a specific browser build to get past a block \u2014 that is an arms race, and the site is "
        + "run by volunteers.\n"
        + "Do this instead: open the page in a browser, download what you need, and point the workbench at the local file; or "
        + "wait and retry later; or ask the decomp.me maintainers for API access if you need this regularly.");
    }
    if (status === 429) return new RateLimited(`${url} is rate limiting this client (HTTP 429) and it was already retried once. Wait before trying again, and serialize requests rather than running them in parallel.`);
    if (status >= 500) return new NetworkError(`${url} failed on the server side (HTTP ${status}) and the retry failed too. This is not something the command can fix; try again later.`);
    return new NetworkError(`${url} returned an unexpected HTTP ${status}.`);
  }
}

/** The original parser's error sentence: "Expecting value: line 1 column 1 (char 0)". */
function jsonErrorText(text) {
  const firstNonWs = text.search(/\S/);
  const pos = firstNonWs < 0 ? text.length : firstNonWs;
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  const col = pos - (before.lastIndexOf("\n") + 1) + 1;
  return `Expecting value: line ${line} column ${col} (char ${pos})`;
}
