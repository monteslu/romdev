// guide-cli.js - `guide`: the command every `next:` footer names. Expands a
// playbook, verdict or lever number into the field guide's own section, and
// `guide laws ERA [LAW]` prints what the compiler does about it.
//
// Plain JS ESM + JSDoc.

import { lawIndexLines, readLaw, readLaws, renderLaw, renderTopic, resolveTopic, sections, topicIndexLines } from "./field-guide.js";
import { emitLines } from "./terminal.js";
import { terminalArguments } from "./cli-options.js";
import { splitlines } from "./py.js";

export const LAWS_TOPIC = "laws";

const isDocError = (e) => e?.name === "FileNotFoundError" || e?.name === "ValueError";

/** Print the field-guide sections for a playbook, verdict, or lever. */
export async function guideCommand(args, io) {
  if (args.topic === LAWS_TOPIC) return lawsCommand(args, io);
  if (args.era || args.law) {
    io.eprint(`error: the second and third arguments are only used by \`guide ${LAWS_TOPIC} ERA [LAW]\`; pass one topic, or run \`decomp-workbench guide\` for the topic index`);
    return 2;
  }
  if (!args.topic) { emitLines(io, topicIndexLines(), { width: args.width, pager: args.pager }); return 0; }
  let topic;
  try { topic = resolveTopic(args.topic); } catch (e) {
    if (e?.name !== "ValueError") throw e;
    io.eprint(`error: ${e.message}`);
    return 2;
  }
  let available = new Map(), missing = null;
  try { available = sections(); } catch (e) {
    if (e?.name !== "FileNotFoundError") throw e;
    missing = e.message;
  }
  // A missing document is a packaging failure and exits non-zero, but the
  // answer already in memory is still printed.
  emitLines(io, renderTopic(topic, available), { width: args.width, pager: args.pager });
  if (missing !== null) { io.eprint(`error: ${missing}`); return 2; }
  return 0;
}

function lawsCommand(args, io) {
  if (!args.era) { emitLines(io, lawIndexLines(), { width: args.width, pager: args.pager }); return 0; }
  let lines;
  try {
    lines = args.law ? renderLaw(args.era, readLaw(args.era, args.law)) : splitlines(readLaws(args.era));
  } catch (e) {
    if (!isDocError(e)) throw e;
    io.eprint(`error: ${e.message}`);
    return 2;
  }
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

export const COMMAND_SPECS = [
  {
    path: ["guide"], handler: guideCommand, formatter: "raw_description",
    help: "print the field-guide levers, or one era's compiler laws",
    description: "Expand the lever family named by a `next:` footer into the field guide's own text. Run without a topic for the index.\n\n`guide laws ERA` prints something different in kind: not what to change, but what the compiler does about it -- each law with the evidence tier that established it and the earlier claim it corrected. Run `guide laws` for the eras that ship, and `guide laws ERA LAW` for the one law a verdict footer cited.",
    arguments: [
      { dest: "topic", nargs: "?", help: "playbook (forced-color-oracle), verdict (register-permutation), lever number (19), or the word `laws`" },
      { dest: "era", nargs: "?", help: "with `laws`, the compiler era to print (ido53, ido71; the document and prose spellings `ido-7.1` and `IDO 7.1` are accepted too)" },
      { dest: "law", nargs: "?", help: "with `laws ERA`, one law to print instead of the whole page (L64; the spellings `64` and `law 64` are accepted too) -- this is the address a verdict footer prints" },
      ...terminalArguments(),
    ],
  },
];
