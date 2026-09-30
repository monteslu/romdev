// The polite HTTP client, fetch-scratch and public-match-check. Ported from
// the workbench's http_client, decompme_fetch and decompme_search tests. The
// transport is a scripted double (test/fixtures/workbench/fake-http.js); the
// one end-to-end case serves a local HTTP server on 127.0.0.1. Nothing here
// contacts decomp.me.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { Answer, fakeOpener, recordedSleep, htmlAnswer, jsonAnswer, gzip } from "./fixtures/workbench/fake-http.js";
import { MAX_RETRY_AFTER_SECONDS, NetworkError, PoliteClient, RateLimited, RequestRefused, ResourceNotFound } from "../src/decomp/workbench/http-client.js";
import { fetchScratch, scratchSlug } from "../src/decomp/workbench/decompme-fetch.js";
import { addressTerms, publicMatchCheck } from "../src/decomp/workbench/decompme-search.js";
import { buildZip } from "../src/decomp/workbench/zipfile.js";
import * as decompmeCli from "../src/decomp/workbench/decompme-cli.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const URL0 = "https://decomp.me/api/scratch/abcde";
const client = (answers, extra = {}) => {
  const opener = fakeOpener(...answers);
  const sleep = extra.sleep ?? recordedSleep();
  return [new PoliteClient({ opener, sleep, backoff_seconds: 2.0, ...extra }), opener];
};
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-dme-")));

describe("polite client request shape", () => {
  test("every request names the workbench and its version", async () => {
    const [polite, opener] = client([jsonAnswer('{"slug": "abcde"}')]);
    await polite.getJson(URL0);
    const h = opener.requests[0].headers;
    assert.ok(h["User-Agent"].includes("n64-decomp-workbench/"));
    assert.ok(h["User-Agent"].includes("github.com/akratch/n64-decomp-workbench"));
    assert.equal(h.Accept, "application/json");
    assert.ok(h["Accept-Language"]);
    assert.ok(h.Referer);
    assert.ok(!h["User-Agent"].includes("Mozilla"));
  });
  test("a contact is appended to the identity when offered", async () => {
    const [polite, opener] = client([jsonAnswer("{}")], { contact: "me@example.invalid" });
    await polite.getJson(URL0);
    assert.ok(opener.requests[0].headers["User-Agent"].includes("contact:me@example.invalid"));
  });
  test("a compressed body is decoded rather than returned raw", async () => {
    const [polite] = client([new Answer({ body: gzip('{"ok": true}'), headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } })]);
    assert.deepEqual(await polite.getJson(URL0), { ok: true });
  });
});

describe("polite client failures", () => {
  test("a 403 interstitial is explained and never worked around", async () => {
    const [polite, opener] = client([htmlAnswer(403)]);
    await assert.rejects(polite.getJson(URL0), (e) => {
      assert.ok(e instanceof RequestRefused);
      for (const s of ["HTTP 403", "web page rather than the API document", "will not imitate a specific browser build", "browser", "maintainers"]) assert.ok(e.message.includes(s), s);
      return true;
    });
    assert.equal(opener.requests.length, 1);
  });
  test("a missing scratch says so", async () => {
    const [polite] = client([jsonAnswer('{"detail": "Not found."}', { status: 404 })]);
    await assert.rejects(polite.getJson(URL0), (e) => e instanceof ResourceNotFound && e.message.includes("does not exist"));
  });
  test("malformed JSON names what arrived instead", async () => {
    const [polite] = client([new Answer({ body: "<html>not json</html>" })]);
    await assert.rejects(polite.getJson(URL0), (e) => e instanceof NetworkError && e.message.includes("did not answer with JSON") && e.message.includes("not json"));
  });
  test("an unreachable host points at the offline route", async () => {
    const sleep = recordedSleep();
    const [polite, opener] = client([new Answer({ unreachable: "name resolution failed" }), new Answer({ unreachable: "name resolution failed" })], { sleep });
    await assert.rejects(polite.getJson(URL0), (e) => e instanceof NetworkError && e.message.includes("could not reach") && e.message.includes("works offline"));
    assert.equal(opener.requests.length, 2);
    assert.deepEqual(sleep.waits, [2.0]);
  });
});

describe("polite client backoff", () => {
  test("a 429 is retried once after the requested pause", async () => {
    const sleep = recordedSleep();
    const [polite, opener] = client([new Answer({ status: 429, headers: { "Retry-After": "5" } }), jsonAnswer('{"slug": "abcde"}')], { sleep });
    assert.deepEqual(await polite.getJson(URL0), { slug: "abcde" });
    assert.deepEqual(sleep.waits, [5.0]);
    assert.equal(opener.requests.length, 2);
  });
  test("a second 429 stops rather than hammering the server", async () => {
    const sleep = recordedSleep();
    const [polite, opener] = client([new Answer({ status: 429 }), new Answer({ status: 429 })], { sleep });
    await assert.rejects(polite.getJson(URL0), (e) => e instanceof RateLimited && e.message.includes("already retried once"));
    assert.deepEqual(sleep.waits, [2.0]);
    assert.equal(opener.requests.length, 2);
  });
  test("a long Retry-After is reported rather than slept through", async () => {
    const sleep = recordedSleep();
    const [polite, opener] = client([new Answer({ status: 429, headers: { "Retry-After": String(Math.trunc(MAX_RETRY_AFTER_SECONDS) + 60) } })], { sleep });
    await assert.rejects(polite.getJson(URL0), (e) => e instanceof RateLimited && e.message.includes("Nothing was fetched"));
    assert.deepEqual(sleep.waits, []);
    assert.equal(opener.requests.length, 1);
  });
  test("a server error is retried once then reported", async () => {
    const [polite, opener] = client([new Answer({ status: 503 }), new Answer({ status: 503 })]);
    await assert.rejects(polite.getJson(URL0), (e) => e instanceof NetworkError && e.message.includes("server side"));
    assert.equal(opener.requests.length, 2);
  });
});

// ------------------------------------------------------------ fetch-scratch

const METADATA = { slug: "aBcDe", name: "func_800C1A90", platform: "n64", compiler: "ido5.3", compiler_flags: "-O2 -mips2 -g3", diff_label: "func_800C1A90", score: 20, max_score: 12700 };
const MEMBERS = {
  "metadata.json": Buffer.from(JSON.stringify(METADATA), "utf8"),
  "ctx.c": Buffer.from("typedef int s32;\n"),
  "code.c": Buffer.from("s32 func_800C1A90(void) { return 0; }\n"),
  "target.o": Buffer.from("\x7fELF-not-really\n", "latin1"),
  "target.s": Buffer.from("glabel func_800C1A90\njr $ra\n"),
};
const exportZip = (members = MEMBERS) => buildZip(Object.entries(members).map(([name, data]) => ({ name, data })));
const zipAnswer = (members) => new Answer({ body: exportZip(members), headers: { "Content-Type": "application/zip" } });
const fclient = (...answers) => { const opener = fakeOpener(...answers); return [new PoliteClient({ opener, sleep: recordedSleep() }), opener]; };

describe("scratch slug", () => {
  test("a pasted scratch URL is accepted as its slug", () => {
    assert.equal(scratchSlug("https://decomp.me/scratch/aBcDe"), "aBcDe");
    assert.equal(scratchSlug("https://decomp.me/scratch/aBcDe/"), "aBcDe");
    assert.equal(scratchSlug(" aBcDe "), "aBcDe");
  });
  test("a path segment cannot be smuggled into the request", () => {
    for (const v of ["../../etc/passwd", "abc/def", ""]) assert.throws(() => scratchSlug(v), { name: "ValueError" });
  });
});

describe("fetch-scratch", () => {
  test("an export is validated then written to the standard layout", async () => {
    const [polite, opener] = fclient(zipAnswer());
    const d = tmp();
    try {
      const report = await fetchScratch("aBcDe", { client: polite, outdir: d });
      assert.equal(report.output, path.join(d, "aBcDe"));
      for (const [name, content] of Object.entries(MEMBERS)) assert.deepEqual(fs.readFileSync(path.join(report.output, name)), content);
      assert.ok(fs.statSync(path.join(d, "aBcDe.zip")).isFile());
      assert.equal(report.reused, false);
      assert.equal(report.schema, "decomp-workbench-scratch-fetch-v1");
      assert.deepEqual(report.missing_members, []);
      assert.equal(report.metadata.max_score, 12700);
      assert.deepEqual(opener.urls, ["https://decomp.me/api/scratch/aBcDe/export"]);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("an export already on disk is reported without a request", async () => {
    const [polite, opener] = fclient(zipAnswer());
    const d = tmp();
    try {
      await fetchScratch("aBcDe", { client: polite, outdir: d });
      assert.equal(opener.requests.length, 1);
      const again = await fetchScratch("aBcDe", { client: polite, outdir: d });
      assert.equal(again.reused, true);
      assert.equal(opener.requests.length, 1);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("force replaces the cached export", async () => {
    const changed = { ...MEMBERS, "code.c": Buffer.from("s32 func_800C1A90(void) { return 1; }\n") };
    const [polite, opener] = fclient(zipAnswer(), zipAnswer(changed));
    const d = tmp();
    try {
      await fetchScratch("aBcDe", { client: polite, outdir: d });
      const report = await fetchScratch("aBcDe", { client: polite, outdir: d, force: true });
      assert.deepEqual(fs.readFileSync(path.join(report.output, "code.c")), changed["code.c"]);
      assert.equal(report.reused, false);
      assert.equal(opener.requests.length, 2);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("an optional member the export omits is reported, not fatal", async () => {
    const partial = Object.fromEntries(Object.entries(MEMBERS).filter(([n]) => n !== "target.s"));
    const [polite] = fclient(zipAnswer(partial));
    const d = tmp();
    try { assert.deepEqual((await fetchScratch("aBcDe", { client: polite, outdir: d })).missing_members, ["target.s"]); }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("an archive that is not an export leaves nothing behind", async () => {
    const [polite] = fclient(zipAnswer({ "notes.txt": Buffer.from("hello\n") }));
    const d = tmp();
    try {
      await assert.rejects(fetchScratch("aBcDe", { client: polite, outdir: d }), { name: "ValueError" });
      assert.deepEqual(fs.readdirSync(d), []);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("a body that is not a zip fails before touching the output", async () => {
    const [polite] = fclient(new Answer({ body: "<html>not a zip</html>" }));
    const d = tmp();
    try {
      await assert.rejects(fetchScratch("aBcDe", { client: polite, outdir: d }), (e) => e.name === "ValueError" && e.message.includes("not a valid ZIP archive"));
      assert.deepEqual(fs.readdirSync(d), []);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("an unrelated directory is never overwritten", async () => {
    const [polite, opener] = fclient(zipAnswer());
    const d = tmp();
    try {
      fs.mkdirSync(path.join(d, "aBcDe"));
      fs.writeFileSync(path.join(d, "aBcDe", "my-work.c"), "mine\n");
      await assert.rejects(fetchScratch("aBcDe", { client: polite, outdir: d }), (e) => e.message.includes("already exists"));
      assert.ok(fs.existsSync(path.join(d, "aBcDe", "my-work.c")));
      assert.deepEqual(opener.requests, []);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("a refusal is raised with its guidance intact", async () => {
    const [polite] = fclient(htmlAnswer(403));
    const d = tmp();
    try { await assert.rejects(fetchScratch("aBcDe", { client: polite, outdir: d }), (e) => e instanceof RequestRefused && e.message.includes("HTTP 403") && e.message.includes("browser")); }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("a deleted scratch says so", async () => {
    const [polite] = fclient(new Answer({ status: 404, body: '{"detail": "Not found."}' }));
    const d = tmp();
    try { await assert.rejects(fetchScratch("aBcDe", { client: polite, outdir: d }), (e) => e instanceof NetworkError && e.message.includes("does not exist")); }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

async function runWith(argv, answers, cwd = process.cwd()) {
  const saved = decompmeCli.seams.buildClient;
  const [polite] = fclient(...answers);
  decompmeCli.seams.buildClient = () => polite;
  try { return await runCommand(argv, { cwd }); } finally { decompmeCli.seams.buildClient = saved; }
}

describe("fetch-scratch command", () => {
  test("the terminal report names the layout and the next command", async () => {
    const d = tmp();
    try {
      const r = await runWith(["fetch-scratch", "aBcDe", "--outdir", d], [zipAnswer()]);
      assert.equal(r.code, 0);
      assert.equal(r.stderr, "");
      for (const s of ["scratch aBcDe: downloaded", "members: code.c ctx.c metadata.json target.o target.s", "decomp.me display: score=20/12700", "next: decomp-workbench check-scratch"]) assert.ok(r.stdout.includes(s), s);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("the grouped spelling emits the versioned JSON report", async () => {
    const d = tmp();
    try {
      const r = await runWith(["scratch", "fetch", "aBcDe", "--outdir", d, "--json"], [zipAnswer()]);
      const payload = JSON.parse(r.stdout);
      assert.equal(r.code, 0);
      assert.equal(payload.schema, "decomp-workbench-scratch-fetch-v1");
      assert.equal(payload.reused, false);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test("a refusal becomes a structured JSON error", async () => {
    const d = tmp();
    try {
      const r = await runWith(["fetch-scratch", "aBcDe", "--outdir", d, "--json"], [htmlAnswer(403)]);
      const payload = JSON.parse(r.stdout);
      assert.equal(r.code, 2);
      assert.equal(payload.schema, "decomp-workbench-error-v1");
      assert.ok(payload.error.message.includes("will not imitate"));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

// ------------------------------------------------------ public-match-check

const page = (...results) => jsonAnswer(JSON.stringify({ count: results.length, results }));
const scratch = (slug, { name = "func_800C1A90", owner = "someone", score = 20, max_score = 12700, match_override = false } = {}) =>
  ({ slug, name, owner: { username: owner }, score, max_score, match_override, last_updated: "2026-05-01T10:00:00Z" });

describe("public-match-check", () => {
  test("an address is searched in every spelling a name might use", () => {
    assert.deepEqual(addressTerms("0x800C1A90"), ["800C1A90", "800c1a90", "0x800c1a90"]);
    assert.deepEqual(addressTerms("800c1a90"), addressTerms("0x800C1A90"));
  });
  test("something that is not an address is refused clearly", () => {
    assert.throws(() => addressTerms("main"), /not a hexadecimal address/);
  });
  test("a site-verified zero is the loudest thing in the report", async () => {
    const [polite] = fclient(page(scratch("aBcDe", { score: 0 })));
    const report = await publicMatchCheck({ client: polite, query: "func_800C1A90" });
    assert.equal(report.verdict, "public-match-exists");
    assert.deepEqual(report.public_matches, ["aBcDe"]);
    assert.equal(report.results[0].public_match, true);
    assert.equal(report.results[0].url, "https://decomp.me/scratch/aBcDe");
  });
  test("an owner-declared match is separated from a verified one", async () => {
    const [polite] = fclient(page(scratch("claim", { score: 400, match_override: true })));
    const report = await publicMatchCheck({ client: polite, query: "func_800C1A90" });
    assert.equal(report.verdict, "override-claim-only");
    assert.deepEqual(report.override_claims, ["claim"]);
    assert.deepEqual(report.public_matches, []);
  });
  test("the address finds a scratch the name did not", async () => {
    const [polite, opener] = fclient(page(), page(scratch("byaddr", { name: "D_800C1A90", score: 0 })), page(), page());
    const report = await publicMatchCheck({ client: polite, query: "func_800C1A90", address: "0x800C1A90" });
    assert.deepEqual(report.public_matches, ["byaddr"]);
    assert.deepEqual(report.results[0].found_by, ["800C1A90"]);
    assert.equal(opener.requests.length, 4);
    assert.ok(opener.urls[0].includes("search=func_800C1A90"));
    assert.ok(opener.urls[1].includes("search=800C1A90"));
  });
  test("one scratch found by two terms is reported once", async () => {
    const [polite] = fclient(page(scratch("both", { score: 0 })), page(scratch("both", { score: 0 })), page(), page());
    const report = await publicMatchCheck({ client: polite, query: "func_800C1A90", address: "800C1A90" });
    assert.equal(report.result_count, 1);
    assert.deepEqual(report.results[0].found_by, ["func_800C1A90", "800C1A90"]);
  });
  test("the max_score binding keeps a data-label-named scratch", async () => {
    const [polite] = fclient(page(scratch("right", { name: "jtbl_800C1A90", score: 0, max_score: 12700 }), scratch("wrong", { name: "func_800C1A90", score: 0, max_score: 4400 })));
    const report = await publicMatchCheck({ client: polite, query: "800C1A90", instructions: 127 });
    assert.deepEqual(report.public_matches, ["right"]);
    assert.equal(report.max_score_binding.max_score, 12700);
    assert.equal(report.max_score_binding.excluded_results, 1);
  });
  test("an instruction count passed as a max_score is flagged", async () => {
    const [polite] = fclient(page(scratch("aBcDe")));
    const report = await publicMatchCheck({ client: polite, query: "x", max_score: 127 });
    assert.ok(report.warnings.length);
    assert.ok(report.warnings[0].includes("--instructions"));
  });
  test("no results reports a verdict and refuses to claim novelty", async () => {
    const [polite] = fclient(page());
    const report = await publicMatchCheck({ client: polite, query: "func_800C1A90" });
    assert.equal(report.verdict, "no-public-match");
    assert.deepEqual(report.results, []);
    assert.ok(report.limits.some((l) => l.includes("not proof")));
  });
  test("a page without results is a clear failure", async () => {
    const [polite] = fclient(jsonAnswer('{"detail": "moved"}'));
    await assert.rejects(publicMatchCheck({ client: polite, query: "func_800C1A90" }), (e) => e.message.includes("did not answer with a search page"));
  });
  test("a result missing a slug is skipped rather than crashing", async () => {
    const [polite] = fclient(jsonAnswer(JSON.stringify({ results: [{ name: "no slug" }, scratch("ok")] })));
    const report = await publicMatchCheck({ client: polite, query: "x" });
    assert.deepEqual(report.results.map((e) => e.slug), ["ok"]);
  });
  test("nothing to search for says why max_score cannot stand alone", async () => {
    const [polite, opener] = fclient();
    await assert.rejects(publicMatchCheck({ client: polite, max_score: 12700 }), (e) => e.message.includes("takes a term"));
    assert.deepEqual(opener.requests, []);
  });
});

describe("public-match-check command", () => {
  test("the terminal report shouts about a match", async () => {
    const r = await runWith(["public-match-check", "func_800C1A90"], [page(scratch("aBcDe", { score: 0 }), scratch("other"))]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.ok(r.stdout.includes("!! MATCH  slug=aBcDe"));
    assert.ok(r.stdout.includes("   near   slug=other"));
    assert.ok(r.stdout.includes("gate 0: a site-verified public match already exists"));
  });
  test("--fail-on-match is the gate a campaign can run in CI", async () => {
    assert.equal((await runWith(["public-match-check", "func_800C1A90", "--fail-on-match"], [page(scratch("aBcDe", { score: 0 }))])).code, 1);
    assert.equal((await runWith(["public-match-check", "func_800C1A90", "--fail-on-match"], [page()])).code, 0);
  });
  test("JSON carries the schema and the gate", async () => {
    const r = await runWith(["scratch", "public-match-check", "func_800C1A90", "--json"], [page(scratch("aBcDe", { score: 0 }))]);
    const payload = JSON.parse(r.stdout);
    assert.equal(r.code, 0);
    assert.equal(payload.schema, "decomp-workbench-public-match-check-v1");
    assert.equal(payload.gate, "gate-0-public-novelty");
  });
  test("a refusal becomes a structured JSON error", async () => {
    const r = await runWith(["public-match-check", "func_800C1A90", "--json"], [htmlAnswer(403)]);
    const payload = JSON.parse(r.stdout);
    assert.equal(r.code, 2);
    assert.equal(payload.schema, "decomp-workbench-error-v1");
    assert.ok(payload.error.message.includes("HTTP 403"));
  });
});

describe("the default transport against a local server", () => {
  test("fetch-scratch and public-match-check speak real HTTP to 127.0.0.1", async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, agent: req.headers["user-agent"] });
      if (req.url === "/api/scratch/aBcDe/export") { res.writeHead(200, { "Content-Type": "application/zip" }); res.end(exportZip()); return; }
      if (req.url.startsWith("/api/scratch?search=")) {
        const body = gzipSync(Buffer.from(JSON.stringify({ results: [scratch("aBcDe", { score: 0 })] })));
        res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" }); res.end(body); return;
      }
      if (req.url === "/api/scratch/gone/export") { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"detail": "Not found."}'); return; }
      res.writeHead(500); res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const d = tmp();
    try {
      const f = await runCommand(["fetch-scratch", "aBcDe", "--outdir", d, "--api-base", base, "--json"], { cwd: d });
      assert.equal(f.code, 0, f.stdout + f.stderr);
      assert.equal(JSON.parse(f.stdout).files["code.c"].bytes, MEMBERS["code.c"].length);
      const s = await runCommand(["public-match-check", "func_800C1A90", "--api-base", base, "--json"], { cwd: d });
      assert.equal(JSON.parse(s.stdout).verdict, "public-match-exists");
      const g = await runCommand(["fetch-scratch", "gone", "--outdir", d, "--api-base", base, "--json"], { cwd: d });
      assert.equal(g.code, 2);
      assert.ok(JSON.parse(g.stdout).error.message.includes("does not exist"));
      assert.ok(seen.every((x) => x.agent.startsWith("n64-decomp-workbench/")));
    } finally { server.close(); fs.rmSync(d, { recursive: true, force: true }); }
  });
});
