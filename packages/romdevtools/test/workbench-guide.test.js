// `guide` and `guide laws`: the field guide's numbered levers and the
// era-scoped compiler-laws pages, read from the documents shipped under
// src/decomp/workbench/data/docs/. Ported from the workbench's field_guide
// (document half), compiler_laws and levers law-citation tests.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as FG from "../src/decomp/workbench/field-guide.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { OWNING_PASS_VALUES, PERMUTER_ROUTING_STEPS } from "../src/decomp/workbench/view.js";
import { FileNotFoundError } from "../src/decomp/workbench/py-extra.js";

const LAW_HEADING_RE = /^### (L\d+)\. (.+)$/gm;
const run = (argv) => runCommand(argv);

describe("the packaged field guide", () => {
  test("every shipped section parses with its number", () => {
    const s = FG.sections();
    const numbers = [...s.keys()].sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: Math.max(...numbers) }, (_, i) => i + 1));
    assert.ok(Math.max(...numbers) >= 24);
    assert.equal(s.get(19).family, "When source search is over");
    assert.ok(s.get(19).title.includes("forced-color"));
    assert.equal(s.get(21).family, "When the compiler itself is the variable");
    assert.ok(s.get(7).lines[0].startsWith("### 7."));
  });
  test("a missing section is reported, not raised", () => {
    const pruned = new Map([...FG.sections()].filter(([n]) => n !== 20));
    const rendered = FG.renderTopic(FG.resolveTopic("20"), pruned).join("\n");
    assert.ok(rendered.includes("not in the shipped field guide"));
    assert.ok(rendered.includes(FG.LEVER_ACTIONS[20]));
  });
  test("the levers that arrived late now have their prose", () => {
    const shipped = FG.sections();
    for (const n of [20, 21, 22]) {
      assert.ok(shipped.has(n));
      assert.ok(!shipped.get(n).lines.join("\n").includes("not in the shipped field guide"));
    }
    const rendered = FG.renderTopic(FG.resolveTopic("frontend-lineage"), shipped).join("\n");
    for (const s of ["### 20.", "### 21.", "### 22.", "docs/alternate-frontends.md"]) assert.ok(rendered.includes(s), s);
  });
  test("lever 24 section is shipped and reachable by number", async () => {
    assert.ok(FG.sections().get(24).title.includes("Preprocessor-conditional audit"));
    const r = await run(["guide", "24", "--pager", "never"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("### 24."));
    assert.ok(r.stdout.includes("drawbitmap"));
  });
  test("stack-frame-recovery playbook and section are reachable", async () => {
    assert.equal(FG.PLAYBOOK_LEVERS["stack-frame-recovery"][0], 26);
    assert.ok(FG.sections().has(26));
    const r = await run(["guide", "stack-frame-recovery", "--pager", "never"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("### 26."));
    assert.ok(r.stdout.toLowerCase().includes("allocation is exact"));
  });
  test("post-match cleanup reaches the shipped workflow", async () => {
    assert.deepEqual(FG.PLAYBOOK_LEVERS["post-match-cleanup"], [27]);
    assert.ok(FG.sections().has(27));
    const r = await run(["guide", "post-match-cleanup", "--pager", "never"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("### 27."));
    assert.ok(r.stdout.includes("carrier substitution"));
  });
  test("every playbook lever is in the shipped guide", () => {
    const shipped = FG.sections();
    const cited = new Set(Object.values(FG.PLAYBOOK_LEVERS).flat());
    assert.deepEqual([...cited].filter((n) => !shipped.has(n)), []);
  });
  test("lever 28 is shipped, reachable by number and joins the pool page", async () => {
    assert.ok(FG.sections().get(28).title.includes("allocation contest"));
    const r = await run(["guide", "28", "--pager", "never"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("### 28.") && r.stdout.includes("if (&"));
    const p = await run(["guide", "pool-position", "--pager", "never"]);
    assert.ok(p.stdout.includes("### 28."));
  });
  test("the placement boundary is the measured one", () => {
    const body = FG.sections().get(28).lines.join("\n");
    assert.ok(body.includes("106"));
    assert.ok(!body.includes("whole-scope, not positional"));
    assert.ok(body.toLowerCase().includes("sweep"));
  });
  test("the shipped data names no commercial title", () => {
    for (const t of [FG.readFieldGuide(), FG.readLaws("ido53"), FG.readLaws("ido71")]) {
      assert.ok(!/Mickey|Speedway/.test(t));
      assert.ok(!t.includes(String.fromCharCode(0x2014)));
    }
  });
});

describe("guide command", () => {
  test("no topic lists every topic class", async () => {
    const r = await run(["guide", "--pager", "never"]);
    assert.equal(r.code, 0);
    for (const s of ["forced-color-oracle", "register-permutation", "19"]) assert.ok(r.stdout.includes(s));
  });
  test("a playbook prints each of its sections", async () => {
    const r = await run(["guide", "forced-color-oracle", "--pager", "never"]);
    assert.equal(r.code, 0);
    for (const s of ["### 17.", "### 18.", "### 19."]) assert.ok(r.stdout.includes(s));
  });
  test("a lever number prints one section and its playbook", async () => {
    const r = await run(["guide", "19", "--pager", "never"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("### 19.") && !r.stdout.includes("### 18."));
    assert.ok(r.stdout.includes("decomp-workbench guide forced-color-oracle"));
  });
  test("a verdict resolves to the same page as its playbook", async () => {
    const a = await run(["guide", "register-permutation", "--pager", "never"]);
    const b = await run(["guide", "allocation-mismatch", "--pager", "never"]);
    assert.ok(a.stdout.includes("playbook=forced-color-oracle") && a.stdout.includes("### 19."));
    assert.ok(b.stdout.includes("playbook=pool-position"));
  });
  test("unknown topic points at the index", async () => {
    const r = await run(["guide", "not-a-playbook", "--pager", "never"]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("decomp-workbench guide"));
  });
  test("missing resource degrades to the one-line actions", async () => {
    const saved = FG.guideSeams.readFieldGuide;
    FG.guideSeams.readFieldGuide = () => { throw new FileNotFoundError("the field guide is not installed"); };
    try {
      const r = await run(["guide", "forced-color-oracle", "--pager", "never"]);
      assert.equal(r.code, 2);
      assert.ok(r.stderr.includes("not installed"));
      assert.ok(r.stdout.includes(FG.LEVER_ACTIONS[19]));
      assert.ok(r.stdout.includes("### 19. (not in the shipped field guide)"));
    } finally { FG.guideSeams.readFieldGuide = saved; }
  });
});

describe("compiler laws", () => {
  test("read_laws serves each era's document; spellings are one address", () => {
    for (const [era, [, label]] of Object.entries(FG.LAW_DOCUMENTS)) assert.ok(FG.readLaws(era).includes(`# Compiler laws: ${label}`));
    assert.equal(FG.readLaws("IDO53"), FG.readLaws("ido53"));
    for (const s of ["ido-7.1", "IDO 7.1", "ido 7.1", "7.1"]) assert.equal(FG.readLaws(s), FG.readLaws("ido71"));
  });
  test("an unknown era names the ones that ship", () => {
    assert.throws(() => FG.readLaws("ido62"), (e) => FG.lawEras().every((era) => e.message.includes(era)));
  });
  for (const era of ["ido53", "ido71"]) {
    describe(`content invariants: ${era}`, () => {
      const text = FG.readLaws(era);
      const matches = [...text.matchAll(LAW_HEADING_RE)];
      const sections = new Map(matches.map((m, i) => [m[1], text.slice(m.index, i + 1 < matches.length ? matches[i + 1].index : text.length)]));
      test("carries contiguous, receipted, tiered laws", () => {
        assert.ok(sections.size >= 10);
        const numbers = [...sections.keys()].map((n) => Number(n.slice(1))).sort((a, b) => a - b);
        assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1));
        assert.deepEqual([...sections].filter(([, b]) => !b.includes("Receipt")).map(([n]) => n), []);
        assert.deepEqual([...sections].filter(([, b]) => !/\bT[123]\b/.test(b)).map(([n]) => n), []);
      });
      test("states its era scope, tiers, identity gate and falsification history", () => {
        assert.ok(text.includes(FG.LAW_DOCUMENTS[era][1]));
        assert.ok(text.split(/\s+/).join(" ").includes("No law on this page has been tested"));
        for (const tier of ["**T1**", "**T2**", "**T3**"]) assert.ok(text.includes(tier));
        assert.ok(text.toLowerCase().includes("identity gate") && text.includes("byte-identical"));
        assert.ok([...sections.values()].filter((b) => b.includes("Falsifies")).length >= Math.floor(sections.size / 2));
        assert.ok(text.includes("should not believe"));
        assert.ok(text.includes("No impossibility claims"));
      });
      if (era === "ido71") {
        test("provisional laws say what evidence is missing; the zero-word receipts are quoted", () => {
          for (const [, body] of sections) { const b = body.split(/\s+/).join(" "); if (b.includes("Provisional:")) assert.ok(b.includes("Missing evidence")); }
          for (const basin of ["fd6f35253f3f", "60ac03f5e694", "339c48483cf5", "3ba07814aab3"]) assert.ok(text.includes(basin));
        });
      }
    });
  }
  test("every shipped era is covered by the invariants above", () => {
    assert.deepEqual(FG.lawEras(), ["ido53", "ido71"]);
  });
  test("guide laws lists eras, prints a document, and fails loudly on an unknown era", async () => {
    const list = await run(["guide", "laws"]);
    assert.equal(list.code, 0);
    for (const [era, [, label]] of Object.entries(FG.LAW_DOCUMENTS)) assert.ok(list.stdout.includes(era) && list.stdout.includes(label));
    for (const [era, [, label]] of Object.entries(FG.LAW_DOCUMENTS)) {
      const r = await run(["guide", "laws", era]);
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes(`Compiler laws: ${label}`) && r.stdout.includes("Evidence tiers"));
    }
    const bad = await run(["guide", "laws", "ido62"]);
    assert.equal(bad.code, 2);
    assert.ok(bad.stderr.includes("ido53") && bad.stderr.includes("ido71"));
  });
  test("the topic index advertises laws; extra arguments are refused for ordinary topics", async () => {
    assert.ok((await run(["guide"])).stdout.includes("guide laws"));
    const r = await run(["guide", "structure-buckets", "ido53"]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("guide laws"));
    const ok = await run(["guide", "structure-buckets"]);
    assert.equal(ok.code, 0);
    assert.ok(ok.stdout.includes("FIELD GUIDE"));
    const third = await run(["guide", "pool-position", "ido53", "L66"]);
    assert.equal(third.code, 2);
    assert.ok(third.stderr.includes("laws"));
  });
  test("a law is addressable by its number in every citation spelling", () => {
    const law = FG.readLaw("ido53", "L64");
    assert.equal(law.name, "L64");
    assert.ok((law.title + " " + law.lines.join(" ")).includes("t6 t7 t8 t9 t0"));
    assert.ok(law.section.includes("ugen"));
    for (const s of ["L64", "l64", "64", "law 64", " L64 "]) assert.equal(FG.readLaw("ido53", s).name, "L64");
    assert.throws(() => FG.readLaw("ido53", "L999"), /L1-L/);
  });
  test("the parse covers every law on every shipped page", () => {
    for (const era of Object.keys(FG.LAW_DOCUMENTS)) {
      const parsed = FG.laws(era);
      const headings = [...FG.readLaws(era).matchAll(LAW_HEADING_RE)].map((m) => m[1]);
      assert.deepEqual([...parsed.keys()].sort(), headings.sort());
      for (const [name, law] of parsed) { assert.ok(law.lines[0].startsWith(`### ${name}.`)); assert.ok(law.section); }
    }
  });
  test("the command prints one law and its address", async () => {
    const r = await run(["guide", "laws", "ido53", "L65"]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    for (const s of ["COMPILER LAWS  IDO 5.3  L65", "phantom pop", "docs/compiler-laws/ido-5.3.md", "decomp-workbench guide laws ido53"]) assert.ok(r.stdout.includes(s), s);
    assert.ok(!r.stdout.includes("### L64."));
    const bad = await run(["guide", "laws", "ido53", "L999"]);
    assert.equal(bad.code, 2);
    assert.ok(!bad.stdout.includes("### L1.") && bad.stderr.includes("L999"));
  });
});

describe("law cross-links", () => {
  const cited = () => Object.values(FG.PASS_LAWS).flat().map(([era, law]) => [era, law]);
  test("every cited law exists on the page it names", () => {
    for (const [era, law] of cited()) assert.equal(FG.readLaw(era, law).name, law);
  });
  test("the table is keyed on the passes a verdict can name", () => {
    for (const p of Object.keys(FG.PASS_LAWS)) assert.ok(OWNING_PASS_VALUES.includes(p), p);
    for (const [playbook, passes] of Object.entries(FG.PLAYBOOK_PASSES)) {
      assert.ok(playbook in FG.PLAYBOOK_LEVERS);
      for (const p of passes) assert.ok(OWNING_PASS_VALUES.includes(p));
    }
  });
  test("the campaign laws are each cited somewhere", () => {
    const laws = new Set(cited().map(([, l]) => l));
    for (const l of ["L62", "L63", "L64", "L65", "L66", "L67", "L68", "L70", "L72", "L73", "L76", "L77", "L79", "L80"]) assert.ok(laws.has(l), l);
    assert.ok(PERMUTER_ROUTING_STEPS.join(" ").includes("L69"));
  });
  test("a footer prints the law as a pasteable command that runs", async () => {
    const citation = FG.passLawSteps("ugen-temp-ring").find((s) => s.startsWith("law L64:"));
    assert.ok(citation.includes("decomp-workbench guide laws ido53 L64"));
    const r = await run(citation.split("decomp-workbench ")[1].split(/\s+/));
    assert.equal(r.code, 0, r.stderr);
  });
  test("a lever family prints the law its pass owns; others gain nothing", async () => {
    const r = await run(["guide", "stack-frame-recovery"]);
    assert.ok(r.stdout.includes("law L63:") && r.stdout.includes("decomp-workbench guide laws ido53 L63"));
    assert.deepEqual(FG.playbookLawSteps("post-match-cleanup"), []);
    assert.deepEqual(FG.passLawSteps("unknown"), []);
  });
  test("the lever families' functions and unreachable proofs appear in a law", () => {
    const text = FG.readLaws("ido53");
    for (let n = 72; n <= 82; n++) assert.ok(text.includes(`### L${n}.`));
    for (const name of ["overlay34InitStorage", "func_overlay_026_F0000B18_187AF10", "overlay84InitializeAndUpdate", "overlay20UpdateObjectResource",
      "func_overlay_070_F00000D8", "overlay40UpdateEntries", "func_overlay_047_F00009D0", "func_overlay_014_F0000000",
      "overlay1FindNextAngle", "func_overlay_038_F0000000", "overlay59PrepareEntry", "levelFreeAll"]) assert.ok(text.includes(name), name);
  });
});

describe("guide command UX", () => {
  test("every topic the index advertises resolves", async () => {
    for (const topic of FG.topicNames()) {
      const r = await run(["guide", topic, "--width", "100"]);
      assert.equal(r.code, 0, topic);
      assert.ok(r.stdout.trim(), topic);
    }
  });
  test("a topic that does not exist still fails, and bare guide succeeds", async () => {
    const r = await run(["guide", "no-such-topic"]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("unknown guide topic"));
    const ok = await run(["guide"]);
    assert.equal(ok.code, 0);
    assert.ok(ok.stdout.trim());
  });
  test("--width bounds each line and rejects nonsense", async () => {
    const r = await run(["guide", "19", "--width", "40"]);
    assert.ok(r.stdout.split("\n").every((l) => l.length <= 40));
    const bad = await run(["guide", "19", "--width", "5"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /width must be at least 20 columns/);
  });
});
